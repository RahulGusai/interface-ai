import { open, mkdir } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { ImageContent } from "../contracts/observation.js";
import { PNG } from "pngjs";
export async function stageImage(
  directory: string,
  image: ImageContent,
  kind: string,
) {
  if (!isAbsolute(directory)) throw Error("INVALID_STAGING");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = randomUUID() + ".png";
  const file = await open(join(directory, name), "wx", 0o600);
  try {
    await file.writeFile(image.bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  const png = PNG.sync.read(Buffer.from(image.bytes));
  return {
    staged_path: name,
    kind,
    sha256: createHash("sha256").update(image.bytes).digest("hex"),
    width: png.width,
    height: png.height,
    captured_at: new Date().toISOString(),
  };
}
export function stagingPath(root: string, name: string) {
  if (
    isAbsolute(name) ||
    name.split(/[\\/]/).includes("..") ||
    !resolve(root, name).startsWith(resolve(root) + "/")
  )
    throw Error("INVALID_STAGING");
  return join(root, name);
}
