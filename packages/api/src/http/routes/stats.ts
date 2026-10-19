import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { SettingsService } from '../../settings/service.js';
import { GROUP_BY, type StatsService } from '../../stats/service.js';

export interface StatsRouteDeps {
  stats: StatsService;
  settings: SettingsService;
}

const bucket = z.object({
  key: z.string(),
  cost_usd: z.number(),
  cost_usd_computed: z.number().nullable(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  invocations: z.number(),
});

/** Cost and outcome rollups (§9.2) and the board's stats strip (§13.1). */
export async function statsRoutes(app: FastifyInstance, deps: StatsRouteDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const viewer = app.requireRole('viewer');
  const range = z.object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  });
  const bounds = (q: { from?: Date | undefined; to?: Date | undefined }) => ({
    from: q.from ?? new Date(Date.now() - 30 * 24 * 3600 * 1000),
    to: q.to ?? new Date(Date.now() + 60_000),
  });

  r.get(
    '/api/stats',
    {
      preHandler: viewer,
      schema: {
        tags: ['stats'],
        querystring: range.extend({ group_by: z.enum(GROUP_BY).default('day') }),
        response: {
          200: z.object({
            from: z.string(),
            to: z.string(),
            group_by: z.string(),
            buckets: z.array(bucket),
            note: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const { from, to } = bounds(req.query);
      const tz = (await deps.settings.get()).limits.timezone;
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        group_by: req.query.group_by,
        buckets: await deps.stats.usage(from, to, req.query.group_by, tz),
        note: 'cost_usd is what Claude Code reported; it is a client-side estimate and can differ from the bill.',
      };
    },
  );

  r.get(
    '/api/stats/outcomes',
    { preHandler: viewer, schema: { tags: ['stats'], querystring: range } },
    async (req) => {
      const { from, to } = bounds(req.query);
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        ...(await deps.stats.outcomes(from, to)),
      };
    },
  );

  r.get('/api/stats/board', { preHandler: viewer, schema: { tags: ['stats'] } }, async () => {
    const s = await deps.settings.get();
    return deps.stats.board(s.limits.timezone, s.limits.per_day_usd, s.limits.max_iterations);
  });
}
