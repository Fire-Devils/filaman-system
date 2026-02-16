import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';

const isStatic = process.env.BUILD_MODE === 'static';
const backendUrl = process.env.BACKEND_URL || 'http://localhost:8000';

export default defineConfig({
  output: isStatic ? 'static' : 'server',
  adapter: isStatic ? undefined : node({
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