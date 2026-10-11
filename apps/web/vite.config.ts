import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import vike from "vike/plugin";
import {
  defaultClientConditions,
  defaultExternalConditions,
  defaultServerConditions,
  defineConfig,
} from "vite";

const development = process.env.DIGITAL_DEVELOPMENT === "1";

export default defineConfig({
  plugins: [vike(), vue(), tailwindcss()],
  ...(development
    ? {
        resolve: {
          conditions: ["digital-development", ...defaultClientConditions],
        },
      }
    : {}),
  ssr: {
    external: ["@digital/composition"],
    ...(development
      ? {
          resolve: {
            conditions: ["digital-development", ...defaultServerConditions],
            externalConditions: [
              "digital-development",
              ...defaultExternalConditions,
            ],
          },
        }
      : {}),
  },
});
