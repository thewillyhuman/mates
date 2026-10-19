import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Helm-managed settings (§5.2), rendered by the chart into
 * `/etc/mates/config.json`. Keys present here override UI settings and are
 * shown as "managed by Helm". Absent file → spec defaults.
 */
const schema = z.object({
  config: z
    .object({
      maxIterations: z.number().int().min(1).max(10).optional(),
      budgets: z
        .object({ perRunUsd: z.number().optional(), perDayUsd: z.number().optional() })
        .optional(),
      models: z
        .object({
          intake: z.string().optional(),
          implementer: z.string().optional(),
          reviewer: z.string().optional(),
        })
        .optional(),
      jira: z.object({ pollIntervalSeconds: z.number().int().optional() }).optional(),
      retention: z
        .object({
          transcriptsDays: z.number().int().optional(),
          eventsDays: z.number().int().optional(),
        })
        .optional(),
      timezone: z.string().optional(),
    })
    .optional(),
  runner: z
    .object({
      image: z.string().optional(),
      resources: z.unknown().optional(),
      timeoutSeconds: z.number().int().optional(),
      workspaceSizeGi: z.number().optional(),
      serviceAccount: z.string().optional(),
      imagePullSecrets: z.array(z.object({ name: z.string() })).optional(),
    })
    .optional(),
  credentialsReadOnly: z.boolean().optional(),
  oidc: z
    .object({
      enabled: z.boolean().optional(),
      issuer: z.string().optional(),
      clientId: z.string().optional(),
      scopes: z.string().optional(),
      groupsClaim: z.string().optional(),
      groups: z
        .object({ admin: z.array(z.string()).optional(), operator: z.array(z.string()).optional() })
        .optional(),
    })
    .optional(),
});

export type HelmConfig = z.infer<typeof schema>;

export async function readHelmConfig(file: string | undefined): Promise<HelmConfig> {
  if (!file) return {};
  const parsed = schema.safeParse(JSON.parse(await readFile(file, 'utf8')));
  if (!parsed.success) throw new Error(`invalid ${file}: ${parsed.error.message}`);
  return parsed.data;
}
