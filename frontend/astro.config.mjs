import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';

const backendUrl = process.env.BACKEND_URL || 'http://localhost:8000';

export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
  vite: {
    plugins: [tailwindcss()],
    server: {
      proxy: {
        '/auth': {
          target: backendUrl,
          changeOrigin: true,
          cookieDomainRewrite: {
            '*': '',
          },
        },
        '/api': {
          target: backendUrl,
          changeOrigin: true,
          cookieDomainRewrite: {
            '*': '',
          },
        },
      },
    },
  },
});