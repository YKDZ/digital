-- 显式重连只恢复本库对该物理根的 I/O 通路，不证明对象连续。置位期间该库经此根的历史 Location
-- 暂不进入本库 current 投影，直到一次完整授权观察清零；其他库沿自己的授权代次独立判定。
ALTER TABLE `library_directory_grants` ADD `awaiting_observation` integer NOT NULL DEFAULT 0;
