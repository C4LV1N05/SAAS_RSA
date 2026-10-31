import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);

interface PgLikeError {
  code?: string;
  message?: string;
  cause?: PgLikeError;
}

/** Map validation, Postgres and RLS errors to stable HTTP responses. */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ZodError) {
    return new HttpError(400, 'validation_failed', 'Request validation failed', err.flatten());
  }
  const pgErr = (err as PgLikeError)?.code ? (err as PgLikeError) : (err as PgLikeError)?.cause;
  switch (pgErr?.code) {
    case '42501': // insufficient_privilege: RLS violation or revoked grant
      return new HttpError(403, 'forbidden', 'You do not have access to this record');
    case '23505':
      return new HttpError(409, 'conflict', 'A record with these details already exists');
    case '23503':
      return new HttpError(400, 'invalid_reference', 'A referenced record does not exist');
    case '23514':
    case '22P02':
    case '22007':
      return new HttpError(400, 'invalid_value', pgErr.message ?? 'Invalid value');
    case 'P0001': // raised by our guard triggers (e.g. finalised payroll)
      return new HttpError(409, 'locked', pgErr.message ?? 'Record is locked');
  }
  const e = err as { statusCode?: number; code?: string; message?: string };
  if (e?.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
    return new HttpError(e.statusCode, e.code ?? 'bad_request', e.message ?? 'Bad request');
  }
  return new HttpError(500, 'internal_error', 'Something went wrong');
}
