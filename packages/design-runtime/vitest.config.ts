import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    name: "design-runtime",
    environment: "node",
    setupFiles: [],
    include: ["src/**/*.test.ts"],
  },
});
