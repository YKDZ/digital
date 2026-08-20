import { ReadOnlyFilesystemObserver } from "@digital/filesystem";
import type {
  // @ts-expect-error 生产包根不得导出测试竞态 hook。
  FilesystemObservationTestHooks,
} from "@digital/filesystem";

type ProductionHook = FilesystemObservationTestHooks;
declare const productionHook: ProductionHook;
void productionHook;

// @ts-expect-error 生产构造器不得接受测试竞态 hook。
new ReadOnlyFilesystemObserver({
  afterEntryLstat: () => undefined,
});

new ReadOnlyFilesystemObserver();
