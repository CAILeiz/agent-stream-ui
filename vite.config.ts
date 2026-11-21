import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

const MOCK_SERVER = process.env.MOCK_SERVER_URL ?? 'http://127.0.0.1:8787'

export default defineConfig({
  // 相对路径，方便直接丢到 GitHub Pages 项目页
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: MOCK_SERVER,
        changeOrigin: true,
        // SSE 专属：上游断开时，必须把浏览器侧连接也掐掉。
        // 否则代理会挂着一个"看起来还活着"的响应，前端的 reader 永远等不到 EOF，
        // 断线重连逻辑就永远不会触发。
        configure: (proxy) => {
          proxy.on('error', (_error, _req, res) => {
            const response = res as unknown as { destroy?: () => void }
            response?.destroy?.()
          })
        },
      },
    },
  },
  build: {
    outDir: 'dist-demo',
    sourcemap: true,
  },
})
