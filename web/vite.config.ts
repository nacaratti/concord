import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Em desenvolvimento o Vite repassa a API e o gateway para o servidor Go.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/gateway': { target: 'ws://localhost:8080', ws: true },
    },
  },
})
