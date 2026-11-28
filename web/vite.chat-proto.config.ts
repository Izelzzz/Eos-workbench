import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 只打包对话页原型（web/chat-proto.html），输出到 web/dist-proto
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist-proto', emptyOutDir: true, rollupOptions: { input: 'chat-proto.html' } },
})
