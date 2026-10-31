import { defineConfig } from 'tsup';

// Workspace packages ship TypeScript source, so they are bundled into the app;
// npm dependencies stay external and are installed in the runtime image.
export default defineConfig({
  entry: { index: 'src/main.ts' },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  noExternal: [/^@saas-rsa\//],
});
