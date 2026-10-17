import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifiedFixture } from "../tests/browser/native-fixture.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "buzz-native-fixture-"));
  directories.push(directory);
  writeFileSync(join(directory, "revision"), "checked-revision\n");
  const names = ["fixture-bridge", "buzzodz"];
  for (const name of names)
    writeFileSync(join(directory, name), name, { mode: 0o755 });
  writeFileSync(
    join(directory, "SHA256SUMS"),
    names
      .map(
        (name) =>
          `${createHash("sha256").update(name).digest("hex")}  ${name}\n`,
      )
      .join(""),
  );
  return directory;
}

it("verifies both native executables from one revision and checksum manifest", () => {
  const directory = fixture();
  expect(verifiedFixture(directory, "checked-revision")).toBe(
    join(directory, "fixture-bridge"),
  );
  expect(verifiedFixture(directory, "checked-revision", "buzzodz")).toBe(
    join(directory, "buzzodz"),
  );
});

it("rejects a different revision, missing checksum, altered CLI and nonexecutable CLI", () => {
  const directory = fixture();
  expect(() =>
    verifiedFixture(directory, "wrong-revision", "buzzodz"),
  ).toThrow();
  expect(() =>
    verifiedFixture(directory, "checked-revision", "missing"),
  ).toThrow();
  writeFileSync(join(directory, "buzzodz"), "altered");
  expect(() =>
    verifiedFixture(directory, "checked-revision", "buzzodz"),
  ).toThrow();
  writeFileSync(join(directory, "buzzodz"), "buzzodz");
  if (process.platform !== "win32") {
    chmodSync(join(directory, "buzzodz"), 0o644);
    expect(() =>
      verifiedFixture(directory, "checked-revision", "buzzodz"),
    ).toThrow();
  }
});
