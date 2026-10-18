import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname),
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(import.meta.dirname, "src/background.ts"),
        options: resolve(import.meta.dirname, "options.html"),
      },
      output: {
        entryFileNames: "assets/[name].js",
      },
    },
  },
});
