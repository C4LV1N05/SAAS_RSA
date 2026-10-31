import type { FastifyReply, FastifyRequest } from 'fastify';
import { withTenant, type Database, type TenantContext, type Tx } from '@saas-rsa/db';
import { HttpError } from './errors';
import { can, type Permission } from './permissions';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: TenantContext;
  }
}

export interface Deps {
  db: Database;
}

export function authOf(request: FastifyRequest): TenantContext {
  if (!request.auth) throw new HttpError(401, 'unauthenticated', 'Sign in required');
  return request.auth;
}

/** preHandler: reject early when the role lacks the permission. */
export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const auth = authOf(request);
    if (!can(auth.role, permission)) {
      throw new HttpError(403, 'forbidden', `Your role (${auth.role}) cannot ${permission}`);
    }
  };
}

/** Run the handler's queries in one transaction scoped to the caller's tenant. */
export function tenantTx<T>(deps: Deps, request: FastifyRequest, fn: (tx: Tx, auth: TenantContext) => Promise<T>): Promise<T> {
  const auth = authOf(request);
  return withTenant(deps.db, auth, (tx) => fn(tx, auth));
}
