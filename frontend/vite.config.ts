import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev the backend runs separately (default :9597); proxy /api and /ws to it
// so the frontend always uses same-origin relative URLs, in every environment.
const BACKEND = process.env.VASTMON_BACKEND || "http://127.0.0.1:9597";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/ws": { target: BACKEND.replace(/^http/, "ws"), ws: true },
    },
  },
});
