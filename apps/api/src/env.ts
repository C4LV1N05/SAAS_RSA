import { z } from 'zod';

const optional = <T extends z.ZodTypeAny>(schema: T) => schema.optional().or(z.literal('').transform(() => undefined));

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    LOG_LEVEL: z.string().default('info'),
    DATABASE_URL: z.string().url(),
    // Auth0: https://<tenant>.<region>.auth0.com/.well-known/jwks.json
    AUTH_JWKS_URL: optional(z.string().url()),
    // Auth0: https://<tenant>.<region>.auth0.com/ (trailing slash included)
    AUTH_ISSUER: optional(z.string()),
    // Auth0: the API Identifier you created in the Auth0 dashboard
    AUTH_AUDIENCE: z.string().default('saas-rsa-api'),
    // Prefix the Auth0 Post-Login Action uses for custom claims
    AUTH_CLAIM_NAMESPACE: z.string().default('https://saas-rsa.app/'),
    // Shared secret the Auth0 Action sends to /internal/auth/claims
    AUTH_ACTION_SECRET: optional(z.string().min(32)),
    // Base URL of the guest ordering app; QR codes point at <url>/t/<token>
    GUEST_APP_URL: z.string().url().default('https://order.saas-rsa.app'),
    // Extra browser origins allowed to call the API (comma-separated). The guest app's origin is always allowed.
    CORS_ORIGINS: z.string().default(''),
    // Menu photos: 'azure' (Blob Storage) in production, 'local' (a folder served at /media) for development
    MEDIA_STORE: z.enum(['local', 'azure']).default('local'),
    MEDIA_DIR: z.string().default('.media'),
    MEDIA_PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000/media'),
    AZURE_STORAGE_CONNECTION_STRING: optional(z.string()),
    MEDIA_CONTAINER: z.string().default('menu-images'),
    // Local development only: HS256 shared secret used when AUTH_JWKS_URL is empty
    AUTH_DEV_SECRET: optional(z.string().min(32)),
  })
  .refine((e) => e.AUTH_JWKS_URL || e.AUTH_DEV_SECRET, {
    message: 'Set AUTH_JWKS_URL (production) or AUTH_DEV_SECRET (local development)',
  })
  .refine((e) => e.NODE_ENV !== 'production' || (e.AUTH_JWKS_URL && e.AUTH_ISSUER), {
    message: 'AUTH_JWKS_URL and AUTH_ISSUER are required in production; the dev secret is for local use only',
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
