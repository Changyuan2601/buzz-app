import { expect, it } from "vitest";
import { byteSize, listByteSize, memberByteSize } from "./budget";

it("sizes a list exactly as byteSize does, including after it changes", () => {
  const items = [
    { id: "a", content: "plain", tags: [["h", "channel"]] },
    { id: "b", content: 'quote " and \\ slash', tags: [] },
    { id: "c", content: "héllo 🐝 \n", tags: [["e", "a"]] },
  ];
  for (const count of [0, 1, 2, 3, 2, 3])
    expect(listByteSize(items.slice(0, count))).toBe(
      byteSize(items.slice(0, count)),
    );
  expect(listByteSize([...items].reverse())).toBe(
    byteSize([...items].reverse()),
  );
});

it("sizes a wrapper around a cached member exactly as byteSize does", () => {
  const event = { id: "c", content: "héllo 🐝 \n", tags: [["e", "a"]] };
  for (const revision of [1, 9, 10, 4096, 123456789]) {
    const item = { event, revision };
    expect(memberByteSize(event) + 22 + String(revision).length).toBe(
      byteSize(item),
    );
  }
});
