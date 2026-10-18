import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { ContentAddressedManagedArtifactStore } from "../src/index.ts";

it("从恢复后的托管根按旧产品位置中的内容摘要读取原产物", async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "digital-managed-artifact-restore-"),
  );
  try {
    const sourceRoot = path.join(workspace, "source-product-data");
    const restoredRoot = path.join(workspace, "restored-product-data");
    const bytes = Buffer.from("restored managed artifact");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const sourceLocation = path.join(
      sourceRoot,
      "managed-artifacts",
      digest.slice(0, 2),
      digest,
    );
    const restoredLocation = path.join(
      restoredRoot,
      "managed-artifacts",
      digest.slice(0, 2),
      digest,
    );
    const unrelatedLocation = path.join(
      workspace,
      "observed-media",
      digest.slice(0, 2),
      digest,
    );
    const missingDigest = "f".repeat(64);
    const missingSourceLocation = path.join(
      sourceRoot,
      "managed-artifacts",
      missingDigest.slice(0, 2),
      missingDigest,
    );
    await mkdir(path.dirname(sourceLocation), { recursive: true });
    await writeFile(sourceLocation, bytes);
    await mkdir(path.dirname(restoredLocation), { recursive: true });
    await writeFile(restoredLocation, bytes);

    const store = new ContentAddressedManagedArtifactStore(
      path.join(restoredRoot, "managed-artifacts"),
    );

    expect(store.reference(sourceLocation)).toEqual({ digest });
    await expect(store.isAvailable(sourceLocation)).resolves.toBe(true);
    expect(Buffer.from(await store.read(digest))).toEqual(
      await readFile(restoredLocation),
    );
    expect(store.reference(unrelatedLocation)).toBeUndefined();
    await expect(store.isAvailable(unrelatedLocation)).resolves.toBe(false);
    expect(store.reference(missingSourceLocation)).toEqual({
      digest: missingDigest,
    });
    await expect(store.isAvailable(missingSourceLocation)).resolves.toBe(false);

    await rm(restoredLocation);
    await expect(store.isAvailable(sourceLocation)).resolves.toBe(false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

it("保留非产品目录托管根自身写入产物的引用", async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "digital-managed-artifact-custom-root-"),
  );
  try {
    const store = new ContentAddressedManagedArtifactStore(
      path.join(workspace, "custom-managed-root"),
    );
    const bytes = Buffer.from("custom managed artifact");
    const stored = await store.store({
      bytes,
      mediaType: "application/octet-stream",
    });

    expect(store.reference(stored.location.address)).toEqual({
      digest: stored.blob.digest,
    });
    await expect(store.isAvailable(stored.location.address)).resolves.toBe(
      true,
    );
    expect(Buffer.from(await store.read(stored.blob.digest))).toEqual(bytes);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
