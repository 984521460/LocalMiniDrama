import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import { vendorChunkName } from './src/config/vendorChunks.js'
const backendTarget = process.env.LMD_DEV_BACKEND || 'http://127.0.0.1:5679'
const backendUrl = new URL(backendTarget)
if (backendUrl.protocol !== 'http:' || backendUrl.hostname !== '127.0.0.1' || backendUrl.username || backendUrl.password || backendUrl.pathname !== '/') throw new Error('Development backend must be explicit loopback HTTP')

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
        target: backendTarget,
        changeOrigin: true,
        proxyTimeout: 600000,
        timeout: 600000
      },
      '/static': {
        target: backendTarget,
        changeOrigin: true
      }
    }
  }
})
