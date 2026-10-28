import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { executable, stageBerdCall, validatePin } from "./stage-berd-call.mjs";

const roots = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

function archive(
  name = "berd-call",
  type = "0",
  payload = "standalone native executable",
) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(Buffer.byteLength(payload).toString(8).padStart(11, "0"), 124);
  header.write(type, 156);
  const bytes = Buffer.from(payload);
  return gzipSync(
    Buffer.concat([
      header,
      bytes,
      Buffer.alloc(((512 - (bytes.length % 512)) % 512) + 1024),
    ]),
  );
}

async function fixture(bytes = archive()) {
  const root = await mkdtemp(join(tmpdir(), "buzz-voice-stage-"));
  roots.push(root);
  const binary = join(root, "src-tauri/resources/bin/berd-call");
  const pin = {
    version: "0.6.4",
    revision: "a".repeat(40),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  let downloads = 0;
  const options = {
    root,
    pin,
    target: "aarch64-apple-darwin",
    fetchArtifact: async () => {
      downloads++;
      return new Response(bytes);
    },
  };
  return { root, binary, pin, options, downloads: () => downloads };
}

it("stages only the pinned executable and reuses verified cached bytes", async () => {
  const test = await fixture();
  expect(await stageBerdCall(test.options)).toMatchObject({
    supported: true,
    revision: test.pin.revision,
  });
  expect(await readFile(test.binary, "utf8")).toBe(
    "standalone native executable",
  );
  expect((await stat(test.binary)).mode & 0o777).toBe(0o755);
  await writeFile(test.binary, "damaged staged copy");
  await stageBerdCall(test.options);
  expect(await readFile(test.binary, "utf8")).toBe(
    "standalone native executable",
  );
  expect(test.downloads()).toBe(1);
});

it("reads the single-file archive emitted by the release tar command", async () => {
  const test = await fixture();
  const source = join(test.root, "release");
  await mkdir(source);
  await writeFile(join(source, "berd-call"), "released executable");
  const output = join(test.root, "release.tar.gz");
  const result = spawnSync(
    "tar",
    ["--format=ustar", "-czf", output, "-C", source, "berd-call"],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  expect(result.status, result.stderr.toString()).toBe(0);
  const bytes = await readFile(output);
  expect(executable(bytes).toString()).toBe("released executable");
});

it("reports failed downloads without installing a partial binary", async () => {
  const test = await fixture();
  await expect(
    stageBerdCall({
      ...test.options,
      fetchArtifact: async () => new Response(null, { status: 503 }),
    }),
  ).rejects.toThrow("download failed (503)");
  await expect(stat(test.binary)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects oversized downloads before reading their bodies", async () => {
  const test = await fixture();
  await expect(
    stageBerdCall({
      ...test.options,
      fetchArtifact: async () =>
        new Response("payload", {
          headers: { "content-length": String(257 * 1024 * 1024) },
        }),
    }),
  ).rejects.toThrow("exceeds 256 MiB");
  await expect(stat(test.binary)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves the working executable when the downloaded checksum is wrong", async () => {
  const test = await fixture();
  await mkdir(join(test.root, "src-tauri/resources/bin"), { recursive: true });
  await writeFile(test.binary, "previous working version");
  test.options.pin = { ...test.pin, sha256: "0".repeat(64) };
  await expect(stageBerdCall(test.options)).rejects.toThrow("checksum");
  expect(await readFile(test.binary, "utf8")).toBe("previous working version");
});

it("does not reuse a damaged archive from the download cache", async () => {
  const test = await fixture();
  await stageBerdCall(test.options);
  await writeFile(
    join(test.root, "target/berd-call-downloads", `${test.pin.sha256}.tar.gz`),
    "corrupt cache",
  );
  await stageBerdCall(test.options);
  expect(test.downloads()).toBe(2);
});

it("removes stale macOS executables when staging an unsupported target", async () => {
  const test = await fixture();
  await stageBerdCall(test.options);
  expect(
    await stageBerdCall({
      ...test.options,
      target: "x86_64-unknown-linux-gnu",
    }),
  ).toEqual({ supported: false });
  await expect(stat(test.binary)).rejects.toMatchObject({ code: "ENOENT" });
  expect(test.downloads()).toBe(1);
});

it.each(["../berd-call", "/berd-call", "other"])(
  "rejects unexpected archive path %s",
  (name) => {
    expect(() => executable(archive(name))).toThrow("regular file");
  },
);

it.each(["1", "2", "5"])("rejects tar entry type %s", (type) => {
  expect(() => executable(archive("berd-call", type))).toThrow("regular file");
});

it("rejects extra archive entries", () => {
  const first = Buffer.alloc(512);
  first.write("berd-call");
  first.write("00000000001", 124);
  first.write("0", 156);
  const extra = Buffer.alloc(512);
  extra.write("other");
  expect(() =>
    executable(
      gzipSync(
        Buffer.concat([first, Buffer.alloc(512), extra, Buffer.alloc(1024)]),
      ),
    ),
  ).toThrow("regular file");
});

it("rejects moving versions and incomplete provenance pins", () => {
  const pin = {
    version: "0.6.4",
    revision: "a".repeat(40),
    sha256: "b".repeat(64),
  };
  expect(validatePin(pin)).toContain(
    "/v0.6.4/berd-call_0.6.4_darwin-aarch64.tar.gz",
  );
  expect(() => validatePin({ ...pin, version: "latest" })).toThrow(
    "exact version",
  );
  expect(() => validatePin({ ...pin, revision: "main" })).toThrow(
    "source commit",
  );
  expect(() => validatePin({ ...pin, sha256: "" })).toThrow("SHA-256");
});
