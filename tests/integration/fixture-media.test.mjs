import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mediaResponse } from "../browser/fixture-media.mjs";

test("fixture GET byte ranges return truthful slices; unsupported ranges retain whole-file delivery", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "buzz-media-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "clip.mp4");
  await writeFile(path, "0123456789");
  const contentType = "video/mp4";
  for (const [range, text, contentRange] of [
    ["bytes=0-1", "01", "bytes 0-1/10"],
    ["bytes=4-6", "456", "bytes 4-6/10"],
    ["bytes=9-9", "9", "bytes 9-9/10"],
    ["bytes=4-", "456789", "bytes 4-9/10"],
    ["bytes=7-99", "789", "bytes 7-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=-99", "0123456789", "bytes 0-9/10"],
    ["BYTES= 0-1 ", "01", "bytes 0-1/10"],
    ["bytes=8-999999999999999999999", "89", "bytes 8-9/10"],
    ["bytes=-999999999999999999999", "0123456789", "bytes 0-9/10"],
  ])
    await t.test(range, async () => {
      const response = await mediaResponse(path, contentType, range);
      assert.equal(response.status, 206);
      assert.equal(response.contentType, contentType);
      assert.equal(response.body.toString(), text);
      assert.deepEqual(response.headers, {
        "accept-ranges": "bytes",
        "content-range": contentRange,
        "content-length": String(text.length),
      });
      assert.equal(response.path, undefined);
    });
  for (const range of ["bytes=10-", "bytes=-0", "bytes=999999999999999999999-"])
    await t.test(`unsatisfiable ${range}`, async () => {
      const response = await mediaResponse(path, contentType, range);
      assert.equal(response.status, 416);
      assert.equal(response.body.length, 0);
      assert.deepEqual(response.headers, {
        "accept-ranges": "bytes",
        "content-range": "bytes */10",
        "content-length": "0",
      });
      assert.equal(response.path, undefined);
    });
  for (const range of [
    undefined,
    "",
    "bytes=-",
    "bytes=5-2",
    "bytes=0-1,4-5",
    "bytes=0-1,",
    "items=0-1",
    "bytes=nope",
    "bytes=1.5-3",
  ])
    await t.test(`whole-file fallback ${range}`, async () => {
      assert.deepEqual(await mediaResponse(path, contentType, range), {
        path,
        contentType,
      });
    });
});
