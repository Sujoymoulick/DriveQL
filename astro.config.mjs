import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    imageService: 'passthrough',
    platformProxy: {
      enabled: true,
    },
  }),
  vite: {
    optimizeDeps: {
      exclude: ['@electric-sql/pglite'],
    },
    build: {
      rollupOptions: {
        external: ['cloudflare:workers'],
      },
    },
  },
});
