import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192-v2.png', 'icon-512-v2.png'],
      manifest: {
        name: 'Productive v4',
        short_name: 'Productive',
        theme_color: '#4f46e5',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192-v2.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512-v2.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    port: 3005,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        withCredentials: true,
      },
    },
  },
})
