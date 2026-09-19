import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // client-tech-design.md §1.1: the daemon binds a tailnet address, not
    // localhost, so dev-mode proxying to a real duo serve instance needs
    // an explicit target rather than the usual localhost default. Set
    // DUO_SERVE_URL when running `npm run dev` against a real daemon.
    proxy: {
      "/api": {
        target: process.env.DUO_SERVE_URL ?? "http://127.0.0.1:7717",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});
