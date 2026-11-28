import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 只打包导航原型（web/nav-proto.html），输出到 web/dist-proto
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist-proto', emptyOutDir: true, rollupOptions: { input: 'nav-proto.html' } },
})
