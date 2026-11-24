import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src")
    },
    dedupe: ["highlight.js"]
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("node_modules/prosemirror-") ||
            id.includes("node_modules/@tiptap/pm")
          ) {
            return "prosemirror"
          }
          if (
            id.includes("node_modules/highlight.js") ||
            id.includes("node_modules/lowlight")
          ) {
            return "highlight"
          }
        }
      }
    }
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true
      },
      "/manifest.webmanifest": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true
      }
    }
  }
})
