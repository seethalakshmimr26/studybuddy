import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// IMPORTANT: change 'studybuddy' to your exact GitHub repository name
export default defineConfig({
  base: '/studybuddy/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001', // only used in local development
    },
  },
})