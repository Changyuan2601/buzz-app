import { expect, test } from "vitest";
import { threadReference } from "./thread-reference";

// The previous implementation validated every e tag before reading its marker.
function validatingEveryTag(event: {
  readonly tags: readonly (readonly string[])[];
}) {
  let root: string | undefined;
  let reply: string | undefined;
  for (const [name, value, , marker] of event.tags) {
    if (name !== "e" || !value || !/^[0-9a-f]{64}$/i.test(value)) continue;
    if (marker === "root") root = value.toLowerCase();
    if (marker === "reply") reply = value.toLowerCase();
  }
  return reply ? { rootId: root ?? reply, parentId: reply } : undefined;
}

test("matches validating every e tag on mixed NIP-10 tags", () => {
  const hex = (n: number) => n.toString(16).padStart(64, "0");
  const values = [hex(1), hex(2).toUpperCase(), "", "xyz", `${hex(3)}0`];
  const names = ["e", "p", "q", "E"];
  const markers = [undefined, "", "root", "reply", "mention", "ROOT"];
  let seed = 7;
  const pick = <T>(items: readonly T[]) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return items[seed % items.length] as T;
  };
  for (let i = 0; i < 2000; i++) {
    const tags = Array.from({ length: i % 6 }, () => {
      const marker = pick(markers);
      return marker === undefined
        ? [pick(names), pick(values)]
        : [pick(names), pick(values), "", marker];
    });
    expect(threadReference({ tags })).toEqual(validatingEveryTag({ tags }));
  }
});
