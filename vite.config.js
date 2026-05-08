import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
          if (/[\\/]node_modules[\\/]@supabase[\\/]/.test(id)) return 'vendor-supabase'
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) return 'vendor-query'
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}'],
    globals: false,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    proxy: {
      '/api/edhrec': {
        target: 'https://json.edhrec.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/edhrec/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://edhrec.com/',
        },
      },
      '/api/scryfall': {
        target: 'https://api.scryfall.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/scryfall/, ''),
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'ArcaneVault/1.0',
        },
      },
      '/api/archidekt': {
        target: 'https://archidekt.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/archidekt/, ''),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      },
      '/api/moxfield': {
        target: 'https://api.moxfield.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/moxfield/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.moxfield.com/',
          'Origin': 'https://www.moxfield.com',
        },
      },
      '/api/goldfish': {
        target: 'https://www.mtggoldfish.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/goldfish/, ''),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      },
      '/api/combos': {
        target: 'https://backend.commanderspellbook.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/combos/, ''),
        headers: {
          'Origin': 'https://commanderspellbook.com',
          'Referer': 'https://commanderspellbook.com/',
        },
      },
    },
  }
})
