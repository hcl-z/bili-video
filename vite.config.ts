import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/** 后端固定听 127.0.0.1:8788（spec Q31a：只听回环，因此没有登录系统）。 */
const API = 'http://127.0.0.1:8788'

export default defineConfig({
  root: here('./src/web'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': here('./src/web'),
      // 与 package.json 的 imports 字段、三份 tsconfig 的 paths 保持同一个写法。
      '#shared': here('./src/shared'),
    },
  },
  server: {
    // 显式写 127.0.0.1：默认的 'localhost' 在这台机器上只绑 ::1，
    // 于是 http://127.0.0.1:5173 连不上，排查起来很浪费时间。
    host: '127.0.0.1',
    port: 5173,
    // root 在 src/web，但 #shared 指向它外面，要显式放行。
    fs: { allow: [here('.')] },
    proxy: {
      '/api': { target: API, changeOrigin: true },
      // SSE：必须关掉代理层的缓冲，否则事件会被攒着一起送。
      '/events': { target: API, changeOrigin: true, ws: false },
    },
  },
  build: {
    outDir: here('./dist/web'),
    emptyOutDir: true,
    sourcemap: true,
  },
})
