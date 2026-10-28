import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const files = [
  "plugin/plugin.js",
  "plugin/manifest.json",
  "bin/berd-call-start",
];

export async function stageBerdCallPlugin({ root, target }) {
  const destination = join(root, "src-tauri/resources/bin/berd-call-start");
  if (target !== "aarch64-apple-darwin") {
    await rm(destination, { force: true });
    return { supported: false };
  }
  const pin = JSON.parse(
    await readFile(join(root, "runtime/berd-call-plugin.json"), "utf8"),
  );
  if (!/^[a-f0-9]{40}$/.test(pin.revision))
    throw new Error("Berd Call plugin requires an exact source commit");
  // Validate the complete upstream artifact before replacing any staged file.
  const bytes = await Promise.all(
    files.map(async (file) => {
      const data = await readFile(join(root, "runtime/berd-call-plugin", file));
      if (createHash("sha256").update(data).digest("hex") !== pin.files[file])
        throw new Error(`Berd Call plugin checksum mismatch: ${file}`);
      return data;
    }),
  );
  const pending = `${destination}.${randomUUID()}`;
  await mkdir(join(root, "src-tauri/resources/bin"), { recursive: true });
  try {
    await writeFile(pending, bytes[2], { mode: 0o755 });
    await rename(pending, destination);
    await chmod(destination, 0o755);
  } finally {
    await rm(pending, { force: true });
  }
  return { supported: true, revision: pin.revision };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(
    await stageBerdCallPlugin({
      root: fileURLToPath(new URL("../", import.meta.url)),
      target:
        process.env.TAURI_ENV_TARGET_TRIPLE ||
        (process.platform === "darwin" && process.arch === "arm64"
          ? "aarch64-apple-darwin"
          : "unsupported"),
    }),
  );
}
