/** Small fetch wrapper for the SAAS_RSA API. */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Send a file as the raw body (e.g. a photo) instead of JSON. */
  file?: Blob;
  /** Staff bearer token. */
  token?: string;
  /** Guest table session token. */
  guestSession?: string;
  /** Makes retries safe (orders, clock-ins). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.file) headers['content-type'] = opts.file.type || 'application/octet-stream';
  else if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.guestSession) headers['x-guest-session'] = opts.guestSession;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? (opts.body === undefined && !opts.file ? 'GET' : 'POST'),
      headers,
      ...(opts.file ? { body: opts.file } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'offline', 'No connection. Check your signal and try again.');
  }
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return json as T;
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
