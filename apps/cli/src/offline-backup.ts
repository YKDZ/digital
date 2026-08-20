import { createOfflineProductDataBackup } from "@digital/composition";

/** CLI 仅负责命令输入输出；产品根目录布局由 Composition 负责。 */
export async function createOfflineBackup(input: {
  readonly productDataDirectory: string;
  readonly backupDirectory: string;
}): Promise<void> {
  await createOfflineProductDataBackup(input);
}
