import type { AssetInteractionState } from "@digital/domain";

/**
 * 当前单一本地用户对精确产物修订版的最小交互读写。位置和完成状态不从资产、目录或
 * 旧修订版推断；具体持久化和默认 User→Person 初始化保持在外层适配器。
 */
export type CurrentUserInteractionPersistence = {
  readPlaybackInteractions(
    revisionIds: readonly string[],
  ): Promise<readonly AssetInteractionState[]>;
  savePlaybackInteraction(input: AssetInteractionState): Promise<void>;
};

export class CurrentUserPlaybackInteraction {
  private readonly persistence: CurrentUserInteractionPersistence;

  constructor(persistence: CurrentUserInteractionPersistence) {
    this.persistence = persistence;
  }

  async read(revisionIds: readonly string[]) {
    if (revisionIds.some((id) => id.trim().length === 0))
      throw new Error("产物修订版身份无效");
    return await this.persistence.readPlaybackInteractions(revisionIds);
  }

  async save(input: AssetInteractionState): Promise<void> {
    if (
      input.artifactRevisionId.trim().length === 0 ||
      !Number.isSafeInteger(input.positionMilliseconds) ||
      input.positionMilliseconds < 0
    )
      throw new Error("播放交互状态无效");
    await this.persistence.savePlaybackInteraction(input);
  }
}
