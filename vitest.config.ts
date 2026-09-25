import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup/network-denial.ts"],
  },
});
