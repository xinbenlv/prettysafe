import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      'index': 'src/index.ts',
      'shaders/index': 'src/shaders/index.ts',
    },
    format: ['esm'],
    dts: { entry: { 'index': 'src/index.ts' } },
    clean: true,
    outDir: 'dist',
    loader: {
      '.wgsl': 'text',
    },
  },
]);
