import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 各套件的正式 prepare 会恢复同一工作区的 dist；套件内的真实并发仍照常验证。
    fileParallelism: false,
  },
});
