import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
//
// No dev-server proxy: apiRequest (src/api/client.ts) always fetches an
// absolute `${baseUrl}${path}` URL — baseUrl comes from Setup.tsx's
// pairing flow and is always a full origin, by design (client-tech-
// design.md §1.1: the daemon binds a tailnet address, and the whole point
// is a phone reaching a Mac over that tailnet, not a relative-path dev
// convenience). A "/api" proxy here would be dead configuration with
// nothing ever routed through it — pair against a real `duo serve`
// instance during `npm run dev` the same way the built app does.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});
