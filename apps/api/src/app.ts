import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
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
import { GUEST_PREFIX, registerGuestRoutes } from './routes/guest';
import { registerServeRoutes } from './routes/serve';
import type { ServiceEventBus } from './events';

export interface AppOptions extends Deps {
  verify: Verifier;
  /** Shared secret for the Auth0 Action's claims lookup; the route is off without it. */
  authActionSecret?: string;
  /** Live station updates; omitted in tests that do not need streaming. */
  events?: ServiceEventBus;
  guestAppUrl?: string;
  /** Browser origins allowed to call the API (the guest/staff web app). */
  corsOrigins?: string[];
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

  const origins = new Set([
    ...(options.corsOrigins ?? []),
    ...(options.guestAppUrl ? [new URL(options.guestAppUrl).origin] : []),
  ]);
  void app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || origins.has(origin)),
    methods: ['GET', 'POST', 'PUT', 'PATCH'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-guest-session'],
    maxAge: 600,
  });

  app.addHook('onRequest', async (request) => {
    if (request.method === 'OPTIONS') return; // CORS preflight carries no credentials
    const route = request.routeOptions.url ?? '';
    // Guest routes authenticate with the table session token instead (routes/guest.ts).
    if (PUBLIC_ROUTES.has(route) || route.startsWith(`${GUEST_PREFIX}/`)) return;
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
  registerGuestRoutes(app, deps);
  registerServeRoutes(app, deps, {
    ...(options.events ? { events: options.events } : {}),
    guestAppUrl: options.guestAppUrl ?? 'https://order.saas-rsa.app',
  });

  return app;
}
