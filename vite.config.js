import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // biar bisa diakses dari jaringan/Ngrok
    allowedHosts: [
      'c9d23de6822a.ngrok-free.app', // host Ngrok kamu
    ]
  }
})
