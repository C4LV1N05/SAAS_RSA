import { defineConfig } from 'tsup';

// Workspace packages ship TypeScript source, so they are bundled into the app;
// npm dependencies stay external and are installed in the runtime image.
// migrate/seed are bundled too so the same image runs the release migration job.
export default defineConfig({
  entry: {
    index: 'src/server.ts',
    migrate: '../../packages/db/src/migrate.ts',
    seed: '../../packages/db/src/seed.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: [/^@saas-rsa\//],
});
