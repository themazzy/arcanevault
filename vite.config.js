import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: process.env.VITE_CAPACITOR ? '/' : '/arcanevault/',
  plugins: [react()],
  server: {
    allowedHosts: [
      'natalee-endophytous-violinistically.ngrok-free.dev'
    ],
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
