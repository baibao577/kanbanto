import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    // The API server (apps/server) runs next to Vite in development.
    proxy: { '/api': { target: `http://localhost:${process.env.API_PORT ?? 3000}`, ws: true } },
  },
  build: {
    rolldownOptions: {
      output: {
        // Libraries in their own files: they change less often than the app, so browsers keep them cached.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'ui', test: /node_modules[\\/](@radix-ui|radix-ui|@floating-ui|cmdk|sonner|react-remove-scroll)/ },
          ],
        },
      },
    },
  },
})
