import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Integrations } from '../../integrations.js';
import {
  PROMPT_NAMES,
  defaultPrompt,
  validateTemplate,
  type PromptName,
} from '../../invocations/prompts.js';
import {
  CREDENTIAL_NAME,
  CredentialsReadOnlyError,
  InvalidCredentialNameError,
  type CredentialStore,
} from '../../settings/credentials.js';
import { SettingsValidationError, type SettingsService } from '../../settings/service.js';
import {
  MAX_PACKAGE_BYTES,
  TeamContextError,
  type TeamContextService,
  type TeamContextVersion,
} from '../../team-context/service.js';
import { AppError, badRequest, notFound } from '../errors.js';

export interface SettingsRouteDeps {
  settings: SettingsService;
  credentials: CredentialStore;
  teamContext: TeamContextService;
  integrations: Integrations;
}

const credentialStatus = z.object({
  name: z.string(),
  set: z.boolean(),
  set_at: z.string().nullable(),
  last_validated_at: z.string().nullable(),
  read_only: z.boolean(),
});

const teamContextVersion = z.object({
  id: z.string(),
  version: z.number(),
  source: z.enum(['git', 'upload']),
  ref: z.string().nullable(),
  manifest: z.record(z.string(), z.unknown()).nullable(),
  errors: z.array(z.string()),
  fetchedAt: z.string(),
  active: z.boolean(),
  createdBy: z.string().nullable(),
  sizeBytes: z.number(),
});

/** Settings, credentials, team context and prompts (§12, admin only). */
export async function settingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const admin = app.requireRole('admin');
  const viewer = app.requireRole('viewer');

  r.get('/api/settings', { preHandler: admin, schema: { tags: ['settings'] } }, async () => ({
    settings: await deps.settings.get(),
    managed: deps.settings.managedPaths(),
  }));

  r.put(
    '/api/settings',
    { preHandler: admin, schema: { tags: ['settings'], body: z.record(z.string(), z.unknown()) } },
    async (req) => {
      try {
        const { settings, ignored } = await deps.settings.update(req.body, req.user!.email);
        return { settings, managed: deps.settings.managedPaths(), ignored };
      } catch (err) {
        if (err instanceof SettingsValidationError)
          throw badRequest('invalid_settings', err.message);
        throw err;
      }
    },
  );

  const name = z.object({ name: z.string().regex(CREDENTIAL_NAME) });

  r.get(
    '/api/settings/credentials/:name',
    {
      preHandler: admin,
      schema: { tags: ['settings'], params: name, response: { 200: credentialStatus } },
    },
    async (req) => ({
      ...(await deps.credentials.status(req.params.name)),
      read_only: deps.credentials.readOnly,
    }),
  );

  r.put(
    '/api/settings/credentials/:name',
    {
      preHandler: admin,
      schema: {
        tags: ['settings'],
        params: name,
        body: z.object({ value: z.string().min(1) }),
        response: { 200: credentialStatus },
      },
    },
    async (req) => {
      try {
        await deps.credentials.set(req.params.name, req.body.value, req.user!.email);
      } catch (err) {
        if (err instanceof CredentialsReadOnlyError)
          throw new AppError(409, 'credentials_read_only', err.message);
        if (err instanceof InvalidCredentialNameError) throw notFound('credential');
        throw err;
      }
      return {
        ...(await deps.credentials.status(req.params.name)),
        read_only: deps.credentials.readOnly,
      };
    },
  );

  r.delete(
    '/api/settings/credentials/:name',
    {
      preHandler: admin,
      schema: { tags: ['settings'], params: name, response: { 204: z.null() } },
    },
    async (req, reply) => {
      try {
        await deps.credentials.delete(req.params.name, req.user!.email);
      } catch (err) {
        if (err instanceof CredentialsReadOnlyError)
          throw new AppError(409, 'credentials_read_only', err.message);
        throw err;
      }
      return reply.status(204).send(null);
    },
  );

  // §6.2 "Test" buttons: pass/fail with a reason, never the secret itself.
  r.post(
    '/api/settings/credentials/:name/test',
    {
      preHandler: admin,
      schema: {
        tags: ['settings'],
        params: name,
        response: {
          200: z.object({
            ok: z.boolean(),
            message: z.string(),
            details: z.record(z.string(), z.unknown()).default({}),
          }),
        },
      },
    },
    async (req) => {
      const n = req.params.name;
      const settings = await deps.settings.get();
      if (n === 'jira_token') {
        const tracker = await deps.integrations.tracker();
        if (!tracker)
          return { ok: false, message: 'set the Jira base URL and token first', details: {} };
        const result = await tracker.test(deps.integrations.triggerRule(settings));
        if (result.ok) await deps.credentials.markValidated(n);
        return { ok: result.ok, message: result.message, details: { matched: result.matched } };
      }
      const scmMatch = /^scm_(.+)_token$/.exec(n);
      if (scmMatch) {
        const scm = await deps.integrations.scm(scmMatch[1]!);
        if (!scm)
          return {
            ok: false,
            message: `configure provider "${scmMatch[1]}" and its token first`,
            details: {},
          };
        const result = await scm.test();
        if (result.ok) await deps.credentials.markValidated(n);
        return { ok: result.ok, message: result.message, details: { repos: result.repos } };
      }
      if (n === 'anthropic_api_key') {
        return {
          ok: false,
          message: 'the Anthropic test runs a short-lived Job; available with the settings UI (M6)',
          details: {},
        };
      }
      return {
        ok: (await deps.credentials.status(n)).set,
        message: 'no connectivity test for this credential',
        details: {},
      };
    },
  );

  r.get(
    '/api/settings/team-context',
    {
      preHandler: viewer,
      schema: {
        tags: ['settings'],
        response: {
          200: z.object({
            active: teamContextVersion.nullable(),
            versions: z.array(teamContextVersion),
          }),
        },
      },
    },
    async () => {
      const versions = (await deps.teamContext.list()).map(serialiseVersion);
      return { active: versions.find((v) => v.active) ?? null, versions };
    },
  );

  // Upload a tar.gz package as the raw request body (content-type: application/gzip).
  r.post(
    '/api/settings/team-context',
    {
      preHandler: admin,
      schema: { tags: ['settings'], response: { 201: teamContextVersion } },
      bodyLimit: MAX_PACKAGE_BYTES,
    },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body))
        throw badRequest(
          'invalid_package',
          'send the tar.gz package as the request body with content-type application/gzip',
        );
      try {
        const v = await deps.teamContext.upload(
          req.body,
          req.user!.email,
          'upload',
          req.headers['x-mates-ref']?.toString() ?? null,
        );
        return reply.status(201).send(serialiseVersion(v));
      } catch (err) {
        if (err instanceof TeamContextError) throw badRequest('invalid_package', err.message);
        throw err;
      }
    },
  );

  r.get(
    '/api/settings/team-context/:id',
    {
      preHandler: viewer,
      schema: {
        tags: ['settings'],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: teamContextVersion },
      },
    },
    async (req) => {
      const v = await deps.teamContext.get(req.params.id);
      if (!v) throw notFound('team context version');
      return serialiseVersion(v);
    },
  );

  const promptName = z.object({ mate: z.enum(PROMPT_NAMES) });
  r.get(
    '/api/settings/prompts/:mate',
    {
      preHandler: viewer,
      schema: {
        tags: ['settings'],
        params: promptName,
        response: {
          200: z.object({
            name: z.string(),
            template: z.string(),
            default: z.string(),
            overridden: z.boolean(),
          }),
        },
      },
    },
    async (req) => {
      const name = req.params.mate as PromptName;
      const settings = await deps.settings.get();
      const def = await defaultPrompt(name);
      return {
        name,
        template: settings.prompts[name] ?? def,
        default: def,
        overridden: name in settings.prompts,
      };
    },
  );

  r.put(
    '/api/settings/prompts/:mate',
    {
      preHandler: admin,
      schema: {
        tags: ['settings'],
        params: promptName,
        body: z.object({ template: z.string().nullable() }),
      },
    },
    async (req) => {
      const name = req.params.mate as PromptName;
      const template = req.body.template;
      if (template !== null) {
        const errors = validateTemplate(name, template);
        if (errors.length) throw new AppError(400, 'invalid_template', errors.join('; '));
      }
      const current = (await deps.settings.get()).prompts;
      const next: Record<string, string> = { ...current };
      if (template === null) delete next[name];
      else next[name] = template;
      // Replace the whole section so a reset actually removes the key.
      await deps.settings.update({ prompts: {} }, req.user!.email);
      await deps.settings.update({ prompts: next }, req.user!.email);
      const def = await defaultPrompt(name);
      return { name, template: next[name] ?? def, default: def, overridden: name in next };
    },
  );
}

function serialiseVersion(v: TeamContextVersion) {
  return {
    id: v.id,
    version: v.version,
    source: v.source,
    ref: v.ref,
    manifest: (v.manifest as unknown as Record<string, unknown> | null) ?? null,
    errors: v.errors,
    fetchedAt: v.fetchedAt.toISOString(),
    active: v.active,
    createdBy: v.createdBy,
    sizeBytes: v.sizeBytes,
  };
}
