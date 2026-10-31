import Fastify, { type FastifyInstance } from 'fastify';
import type { Verifier } from './auth';
import type { Deps } from './context';
import { HttpError, toHttpError } from './errors';
import { registerShiftRoutes } from './routes/shifts';
import { registerTimeRoutes } from './routes/time';
import { registerComplianceRoutes } from './routes/compliance';
import { registerPayrollRoutes } from './routes/payroll';
import { registerTipRoutes } from './routes/tips';
import { registerLogbookRoutes } from './routes/logbook';
import { INTERNAL_AUTH_ROUTE, registerInternalAuthRoutes } from './routes/internal-auth';

export interface AppOptions extends Deps {
  verify: Verifier;
  /** Shared secret for the Auth0 Action's claims lookup; the route is off without it. */
  authActionSecret?: string;
  logLevel?: string;
}

/** Routes that do not take a user's bearer token. */
const PUBLIC_ROUTES = new Set(['/health', INTERNAL_AUTH_ROUTE]);

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: options.logLevel ?? 'info',
      redact: ['req.headers.authorization', 'req.headers["x-internal-secret"]'],
    },
    genReqId: () => crypto.randomUUID(),
  });

  app.addHook('onRequest', async (request) => {
    if (PUBLIC_ROUTES.has(request.routeOptions.url ?? '')) return;
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'unauthenticated', 'Bearer token required');
    request.auth = await options.verify(header.slice('Bearer '.length));
  });

  app.setErrorHandler((err, request, reply) => {
    const httpErr = toHttpError(err);
    if (httpErr.status >= 500) request.log.error({ err }, 'unhandled error');
    void reply.status(httpErr.status).send({
      error: { code: httpErr.code, message: httpErr.message, ...(httpErr.details ? { details: httpErr.details } : {}) },
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  const deps: Deps = { db: options.db };
  registerInternalAuthRoutes(app, options.db, options.authActionSecret);
  registerShiftRoutes(app, deps);
  registerTimeRoutes(app, deps);
  registerComplianceRoutes(app, deps);
  registerPayrollRoutes(app, deps);
  registerTipRoutes(app, deps);
  registerLogbookRoutes(app, deps);

  return app;
}
