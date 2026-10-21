import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * `base: './'` + hash 路由 => 构建产物是「相对路径 + 单页」，
 * 因此同一份 dist 可以放在任意路径下运行：
 *   - 本地 `vite preview`            -> http://localhost:4173/
 *   - GitHub Pages 项目站点          -> https://gtplusblog.github.io/blog-app/
 *   - GitHub Pages 用户站点          -> https://gtplusblog.github.io/app/
 * 无需在构建时写死 base，也不用担心仓库子路径问题。
 */
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      // 注册由 src/lib/use-service-worker.ts 自己接管：插件的 useRegisterSW 在
      // 「首次安装 / 已有 worker 等待」这些边界上会误报「有新版本可用」，
      // 而且自动注入的注册代码会与我们的逻辑重复注册。
      injectRegister: null,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'GUTUN 博客写作',
        short_name: '博客写作',
        description: '在手机上撰写、编辑并发布 Hugo 博客文章',
        lang: 'zh-CN',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f8f8f8',
        theme_color: '#f8f8f8',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // 离线时仍然可以打开 App、写草稿
        navigateFallback: 'index.html',
        // 一次性预缓存的文件上限（默认 2MB，这里放宽以容纳字体）
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [
          {
            // KaTeX 字体仍从 CDN 取（体积大，不适合打进 App），缓存一份以便离线预览公式
            urlPattern: /\.(?:woff2?|ttf|otf)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'katex-fonts',
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
})
