export * from './client';
export * from './tenant';
export * from './rules';
export * as schema from './schema';
// migrate.ts and seed.ts are CLI entry points (pnpm db:migrate / seed) and are
// deliberately not re-exported, so they never get bundled into the API.
