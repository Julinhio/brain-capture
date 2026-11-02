import { execSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Shown discreetly in the app so a deployment can be checked without creating a capture.
// Railway builds have no .git: the deploy sets APP_VERSION to the commit being uploaded.
function appVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Brain Capture',
        short_name: 'Capture',
        description: 'Capture ideas, tasks and links. They get sorted for you.',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#111214',
        theme_color: '#111214',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Android "Share" sheet: the installed app receives the shared page as a GET to /share.
        // GET keeps it simple: no service worker interception, works the same when offline
        // because /share is served from the precached app shell.
        share_target: {
          action: '/share',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
        shortcuts: [
          { name: 'Write a note', url: '/?compose=text', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
          { name: 'Save a link', url: '/?compose=link', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
        ],
      },
      workbox: {
        // The app shell is cached so the app opens without a network; captures themselves
        // are never cached by the service worker (IndexedDB outbox handles offline saves).
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
