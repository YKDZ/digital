import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import vike from "vike/plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vike(), vue(), tailwindcss()],
  ssr: {
    external: ["@digital/composition"],
  },
});
