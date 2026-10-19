import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';

/**
 * Errors the HTTP layer knows how to render. Application code throws these
 * (or domain errors mapped to them in the route); everything else is a 500
 * with a generic message and a full log line.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, msg: string): AppError => new AppError(400, code, msg);
export const unauthorized = (msg = 'authentication required'): AppError =>
  new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'insufficient role'): AppError =>
  new AppError(403, 'forbidden', msg);
export const notFound = (what: string): AppError =>
  new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, msg: string): AppError => new AppError(409, code, msg);

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      void reply.status(err.status).send({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err.code === 'FST_ERR_VALIDATION' && err.validation) {
      void reply.status(400).send({
        error: {
          code: 'validation',
          message: 'request does not match schema',
          details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        },
      });
      return;
    }
    const status =
      typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    void reply.status(status).send({
      error: {
        code: status >= 500 ? 'internal' : 'request',
        message: status >= 500 ? 'internal error' : err.message,
      },
    });
  });
}

/** JSON 404 for API routes; used by the not-found handler in `app.ts`. */
export function sendNotFound(reply: FastifyReply): FastifyReply {
  return reply.status(404).send({ error: { code: 'not_found', message: 'route not found' } });
}
