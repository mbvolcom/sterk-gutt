import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
  // Makes PWA assets available in dev
  publicDir: 'public',
});
