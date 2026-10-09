import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * The page diagrams are drawn in (diagram.html) may load nothing but this site's scripts. Vite's own tools for
 * development are more than that (a script written into the page, a connection to reload it by), so while
 * developing, and only then, that page is allowed those two. It still loads no picture or style from anywhere.
 */
const diagramPageWhileDeveloping = (): Plugin => ({
  name: 'diagram-page-while-developing',
  apply: 'serve',
  transformIndexHtml: {
    order: 'pre',
    handler: (html, ctx) =>
      ctx.path.endsWith('/diagram.html') ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:") : html,
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), diagramPageWhileDeveloping()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    // The API server (apps/server) runs next to Vite in development.
    proxy: { '/api': { target: `http://localhost:${process.env.API_PORT ?? 3000}`, ws: true } },
  },
  build: {
    rolldownOptions: {
      // Two pages: the app, and the one diagrams are drawn in (see src/components/text/diagram.ts).
      input: { main: path.resolve(import.meta.dirname, 'index.html'), diagram: path.resolve(import.meta.dirname, 'diagram.html') },
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
