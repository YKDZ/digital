import path from "node:path";
import { fileURLToPath } from "node:url";

import { dev } from "vike/api";

const cacheDir = process.env.DIGITAL_DEVELOPMENT_CACHE;
if (process.env.DIGITAL_DEVELOPMENT !== "1" || cacheDir === undefined)
  throw new Error("开发服务必须由环境公共生命周期启动");

await dev({
  viteConfig: {
    root: fileURLToPath(new URL("../", import.meta.url)),
    cacheDir: path.resolve(cacheDir),
    server: {
      host: "127.0.0.1",
      port: Number(process.env.PORT),
      strictPort: true,
    },
  },
});
