import { createRequire } from "node:module";

import { run } from "vue-tsc";

const require = createRequire(import.meta.url);

const compatibilityPackage = require.resolve("typescript/package.json");
const requireCompatibilityDependency = createRequire(compatibilityPackage);

// 官方兼容包以 `@typescript/old` 名义拥有真正的 TypeScript 6 编译器；
// 从该包解析，以遵守隔离链接。
run(requireCompatibilityDependency.resolve("@typescript/old/lib/tsc.js"));
