import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

/** 只读遍历普通素材，供验收前后比较输入字节。 */
export async function digestDirectory(directory: string): Promise<string> {
  const entries = await collectFiles(directory, "");
  entries.sort((left, right) => (left.relative < right.relative ? -1 : 1));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.relative);
    hash.update("\0");
    hash.update(entry.digest);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function collectFiles(
  directory: string,
  prefix: string,
): Promise<{ readonly relative: string; readonly digest: string }[]> {
  const found: { readonly relative: string; readonly digest: string }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative =
      prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory())
      found.push(...(await collectFiles(absolute, relative)));
    else if (entry.isFile())
      found.push({
        relative,
        digest: await digestFile(absolute),
      });
  }
  return found;
}

async function digestFile(location: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(location)) hash.update(chunk);
  return hash.digest("hex");
}
