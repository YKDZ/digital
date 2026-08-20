import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import vike from "vike/plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vike(), vue(), tailwindcss()],
  resolve: {
    alias: {
      "#": fileURLToPath(new URL(".", import.meta.url)),
      "@digital/presentation": fileURLToPath(
        new URL("../../packages/presentation/src/index.ts", import.meta.url),
      ),
    },
  },
});
