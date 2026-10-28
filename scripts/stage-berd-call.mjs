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
import { gunzipSync } from "node:zlib";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const limit = 256 * 1024 * 1024;

export function validatePin(pin) {
  if (
    !pin ||
    !/^\d+\.\d+\.\d+$/.test(pin.version) ||
    !/^[a-f0-9]{40}$/.test(pin.revision) ||
    !/^[a-f0-9]{64}$/.test(pin.sha256)
  )
    throw new Error(
      "Berd Call requires an exact version, source commit and SHA-256 pin",
    );
  return `https://github.com/block/berd/releases/download/v${pin.version}/berd-call_${pin.version}_darwin-aarch64.tar.gz`;
}

// The release contract is one regular file. Parse it without extracting archive paths.
export function executable(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: limit });
  const field = (start, length) =>
    tar
      .subarray(start, start + length)
      .toString("utf8")
      .replace(/\0.*$/s, "");
  const name = field(0, 100).replace(/^\.\//, "");
  const sizeField = field(124, 12).trim();
  const size = /^[0-7]+$/.test(sizeField) ? Number.parseInt(sizeField, 8) : 0;
  const end = 512 + size;
  const next = 512 + Math.ceil(size / 512) * 512;
  if (
    name !== "berd-call" ||
    field(345, 155) ||
    ![0, 48].includes(tar[156]) ||
    !size ||
    end > tar.length ||
    tar.length < next + 1024 ||
    tar.subarray(next).some((byte) => byte !== 0)
  )
    throw new Error(
      "Expected an archive containing only the regular file berd-call",
    );
  return tar.subarray(512, end);
}

export async function stageBerdCall({
  root,
  pin,
  target,
  fetchArtifact = fetch,
}) {
  const destination = join(root, "src-tauri/resources/bin");
  const binary = join(destination, "berd-call");
  if (target !== "aarch64-apple-darwin") {
    await rm(binary, { force: true });
    return { supported: false };
  }
  const url = validatePin(pin);
  const cache = join(root, "target/berd-call-downloads");
  const archive = join(cache, `${pin.sha256}.tar.gz`);
  let bytes = await readFile(archive).catch(() => undefined);
  if (!bytes || digest(bytes) !== pin.sha256) {
    const response = await fetchArtifact(url);
    if (!response.ok)
      throw new Error(`Berd Call download failed (${response.status})`);
    const declared = Number(response.headers.get("content-length"));
    if (declared > limit) throw new Error("Berd Call archive exceeds 256 MiB");
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > limit)
        throw new Error("Berd Call archive exceeds 256 MiB");
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
    if (digest(bytes) !== pin.sha256)
      throw new Error("Berd Call archive checksum does not match its pin");
    await mkdir(cache, { recursive: true });
    const pending = `${archive}.${randomUUID()}`;
    await writeFile(pending, bytes);
    await rename(pending, archive);
  }
  const payload = executable(bytes);
  const current = await readFile(binary).catch(() => undefined);
  if (!current || digest(current) !== digest(payload)) {
    await mkdir(destination, { recursive: true });
    const pending = `${binary}.${randomUUID()}`;
    try {
      await writeFile(pending, payload, { mode: 0o755 });
      await rename(pending, binary);
    } finally {
      await rm(pending, { force: true });
    }
  }
  await chmod(binary, 0o755);
  return {
    supported: true,
    version: pin.version,
    revision: pin.revision,
    sha256: digest(payload),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const target =
    process.env.TAURI_ENV_TARGET_TRIPLE ||
    (process.platform === "darwin" && process.arch === "arm64"
      ? "aarch64-apple-darwin"
      : "unsupported");
  const pin =
    target === "aarch64-apple-darwin"
      ? JSON.parse(
          await readFile(
            process.argv[2] || join(root, "runtime/berd-call.json"),
            "utf8",
          ),
        )
      : undefined;
  console.log(await stageBerdCall({ root, pin, target }));
}
