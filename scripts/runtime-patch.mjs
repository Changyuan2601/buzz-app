import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";

// Verify patch inputs before accepting cached binaries, not only before build.
export async function verifiedRuntimePatch(root, patch) {
  if (!patch) return undefined;
  const path = resolve(root, patch.path);
  const local = relative(root, path);
  if (isAbsolute(local) || local.startsWith(".."))
    throw new Error("Runtime patch must be inside the repository");
  const bytes = await readFile(path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== patch.sha256) throw new Error("Runtime patch checksum mismatch");
  return bytes;
}
