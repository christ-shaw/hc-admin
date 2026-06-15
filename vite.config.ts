import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function patchFadeOutKeyframes(code: string) {
  return code
    .replace(/to\{display:none;opacity:0\}/g, 'to{visibility:hidden;opacity:0}')
    .replace(/to\{opacity:0;display:none\}/g, 'to{opacity:0;visibility:hidden}')
    .replace(/100%\{opacity:0;display:none\}/g, '100%{opacity:0;visibility:hidden}')
}

function patchTextSizeAdjust(code: string) {
  return code
    .replace(
      /html,:host\{([^}]*)-webkit-text-size-adjust:100%;(?![^}]*text-size-adjust)/g,
      'html,:host{$1-webkit-text-size-adjust:100%;text-size-adjust:100%;'
    )
}

function patchTDesignCssWarnings() {
  return {
    name: 'patch-tdesign-css-warnings',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!id.includes('tdesign-react')) return null

      return patchFadeOutKeyframes(code)
    },
    generateBundle(_: unknown, bundle: Record<string, any>) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'asset' && chunk.fileName.endsWith('.css') && typeof chunk.source === 'string') {
          chunk.source = patchTextSizeAdjust(patchFadeOutKeyframes(chunk.source))
        }
      }
    },
  }
}

export default defineConfig({
  base: '/',
  plugins: [patchTDesignCssWarnings(), react()],
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
