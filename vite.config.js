import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/arcanevault/', 
  plugins: [react()],
  server: {
    allowedHosts: [
      'natalee-endophytous-violinistically.ngrok-free.dev'
    ]
  }
})
