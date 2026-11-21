import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// 배포 경로: 루트가 아니면 BASE=/gyeol/app/ 처럼 지정
const base = process.env.BASE ?? '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: '결',
        short_name: '결',
        description: '돌리고, 놓고, 뒤집는 2인 전략 보드게임',
        lang: 'ko',
        theme_color: '#f4efe7',
        background_color: '#1c1b1a',
        display: 'standalone',
        orientation: 'any',
        start_url: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 앱 화면만 미리 저장하고, AI 실행 파일(약 14MB)은 처음 AI 대국 때 저장한다
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        globIgnores: ['ort/**', 'model/**'],
        runtimeCaching: [
          {
            urlPattern: /\/(ort|model)\//,
            handler: 'CacheFirst',
            options: { cacheName: 'gyeol-ai', expiration: { maxEntries: 10 } },
          },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  server: { port: 5180, proxy: { '/ws': { target: 'ws://localhost:8787', ws: true }, '/api': { target: 'http://localhost:8787' } } },
  preview: { port: 5181, proxy: { '/ws': { target: 'ws://localhost:8787', ws: true }, '/api': { target: 'http://localhost:8787' } } },
});
