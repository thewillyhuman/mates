import type { FastifyInstance } from 'fastify';
import type { Integrations } from '../../integrations.js';
import type { Logger } from '../../logger.js';
import type { RunStarter } from '../../runs/starter.js';
import type { SettingsService } from '../../settings/service.js';
import type { WebhookRequest } from '../../tracker/tracker.js';
import { AppError } from '../errors.js';

export interface WebhookRouteDeps {
  settings: SettingsService;
  integrations: Integrations;
  starter: RunStarter;
  log: Logger;
}

/** `POST /webhooks/jira` (§8.1): secret-validated; issue updates start runs, comments answer clarifications. */
export async function webhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): Promise<void> {
  app.post('/webhooks/jira', { config: { rawBody: true } }, async (req, reply) => {
    const tracker = await deps.integrations.tracker();
    if (!tracker) throw new AppError(503, 'tracker_not_configured', 'Jira is not configured');
    const request: WebhookRequest = {
      headers: req.headers as WebhookRequest['headers'],
      query: req.query as Record<string, string | undefined>,
      body: req.body,
    };
    if (!tracker.verifyWebhook(request))
      throw new AppError(401, 'invalid_webhook_secret', 'webhook secret missing or wrong');
    const settings = await deps.settings.get();
    const events = tracker.parseWebhook(request, deps.integrations.triggerRule(settings));
    let created = 0;
    let requeued = 0;
    for (const e of events) {
      if (e.type === 'issue_updated' && e.matchesRule) {
        const r = await deps.starter.start(e.key, 'webhook', 'jira-webhook');
        if (r.created) created += 1;
      } else if (e.type === 'comment_created') {
        if ((await deps.starter.handleComment(e.key, e)) === 'requeued') requeued += 1;
      }
    }
    deps.log.info({ events: events.length, created, requeued }, 'jira webhook processed');
    return reply.status(202).send({ events: events.length, created, requeued });
  });
}
