import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import { vendorChunkName } from './src/config/vendorChunks.js'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: vendorChunkName
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: 3013,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5679',
        changeOrigin: true,
        proxyTimeout: 600000,
        timeout: 600000
      },
      '/static': {
        target: 'http://127.0.0.1:5679',
        changeOrigin: true
      }
    }
  }
})
