import { z } from 'zod';

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    LOG_LEVEL: z.string().default('info'),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().optional(),
    AUTH_JWKS_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
    AUTH_ISSUER: z.string().optional().or(z.literal('').transform(() => undefined)),
    AUTH_AUDIENCE: z.string().default('saas-rsa-api'),
    AUTH_DEV_SECRET: z.string().min(32).optional(),
  })
  .refine((e) => e.AUTH_JWKS_URL || e.AUTH_DEV_SECRET, {
    message: 'Set AUTH_JWKS_URL (production) or AUTH_DEV_SECRET (local development)',
  })
  .refine((e) => e.NODE_ENV !== 'production' || e.AUTH_JWKS_URL, {
    message: 'AUTH_JWKS_URL is required in production; the dev secret is for local use only',
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
