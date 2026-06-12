import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-tdesign': ['tdesign-react'],
          'vendor-recharts': ['recharts'],
          'vendor-xlsx': ['xlsx'],
          'vendor-cloudbase': ['@cloudbase/js-sdk'],
          'vendor-icons': ['lucide-react'],
        },
      },
    },
  },
})
