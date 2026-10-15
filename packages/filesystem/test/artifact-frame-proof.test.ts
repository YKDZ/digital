import { readFile, readdir, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, assert, expect, it } from "vitest";

import { ArtifactFrameProofStore } from "../src/index.ts";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map(async (item) => await rm(item, { recursive: true, force: true })),
  );
});

it("publishes the fixed DGFPRF01 manifest and rejects any published-bit change", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "digital-artifact-proof-"));
  cleanup.push(root);
  const bytes = new TextEncoder().encode("abc");
  const store = new ArtifactFrameProofStore(root);
  const proof = await store.build({
    byteLength: bytes.byteLength,
    async readChunk(offset, maximumBytes) {
      const part = bytes.slice(offset, offset + maximumBytes);
      return {
        bytes: part,
        done: offset + part.byteLength === bytes.byteLength,
      };
    },
  });

  expect(proof).toEqual({
    blobDigest:
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    scheme: "artifact-frame-manifest/1",
    byteLength: 3,
    frameSize: 1_048_576,
    frameCount: 1,
    manifestDigest:
      "1cd9fe2e91d62dc0af8f5bc61df91962d28662dbc3512b4ff175bc864cfd9f29",
  });
  const location = path.join(
    root,
    "artifact-proofs/sha256/1c/1cd9fe2e91d62dc0af8f5bc61df91962d28662dbc3512b4ff175bc864cfd9f29.fproof",
  );
  const manifestBytes = await readFile(location);
  expect(manifestBytes.subarray(0, 64).toString("hex")).toBe(
    "4447465052463031000100010010000000000000000000030000000000000001ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(manifestBytes.subarray(64).toString("hex")).toBe(
    "8113a935d2d95c93fdbf5dfc3bf047889b8e27fb453dc5fb2d96d8ad732a83bd",
  );

  const originalByte = manifestBytes[70];
  assert.isDefined(originalByte);
  manifestBytes[70] = originalByte ^ 1;
  await writeFile(location, manifestBytes);
  await expect(store.inspect(proof)).resolves.toBeUndefined();
  await expect(store.open(proof)).rejects.toThrow(
    "artifact proof integrity check failed",
  );
});

it("stops proof construction on the shared operation cancellation and removes staging", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "digital-proof-cancel-"));
  cleanup.push(root);
  let cancelled = false;
  const cancellation = {
    get cancelled() {
      return cancelled;
    },
    get reason() {
      return cancelled ? ("shutdown" as const) : undefined;
    },
    onCancel: () => () => undefined,
  };
  const store = new ArtifactFrameProofStore(root);

  await expect(
    store.build(
      {
        byteLength: 1_048_577,
        async readChunk(offset, maximumBytes) {
          cancelled = true;
          return {
            bytes: new Uint8Array(Math.min(maximumBytes, 1_048_577 - offset)),
            done: false,
          };
        },
      },
      cancellation,
    ),
  ).rejects.toThrow("cancelled");
  await expect(
    readdir(path.join(root, "artifact-proofs/.staging")),
  ).resolves.toEqual([]);
});

it("represents an empty Blob with exactly one 64-byte header and no frames", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-artifact-proof-empty-"),
  );
  cleanup.push(root);
  const store = new ArtifactFrameProofStore(root);
  const proof = await store.build({
    byteLength: 0,
    async readChunk() {
      return { bytes: new Uint8Array(), done: true };
    },
  });
  expect(proof.frameCount).toBe(0);
  const location = path.join(
    root,
    "artifact-proofs/sha256",
    proof.manifestDigest.slice(0, 2),
    `${proof.manifestDigest}.fproof`,
  );
  await expect(readFile(location)).resolves.toHaveLength(64);
});
