import { expect, it } from "vitest";
import { MessageProjection } from "./message-projection";
import { createRelayProfiler } from "./profiling";
import { keypair, message, signed } from "./testing";

const author = keypair(),
  other = keypair(),
  relay = keypair();
const edit = (
  key: typeof author,
  target: string,
  content: string,
  time: number,
) =>
  signed(key, {
    kind: 40003,
    content,
    created_at: time,
    tags: [
      ["h", "c"],
      ["e", target],
    ],
  });

it("keeps the published rows when refolded overlays leave them unchanged", () => {
  const root = message(author, "c", "Root", 1);
  const sibling = message(author, "c", "Sibling", 2);
  const projection = new MessageProjection(
    "c",
    relay.pubkey,
    createRelayProfiler(),
  );
  const before = projection.reconcile([root, sibling], []);
  // Only the author may edit, so this overlay refolds the root to the same row.
  const ignored = edit(other, root.id, "Spoofed", 3);
  expect(projection.reconcile([root, sibling, ignored], [])).toBe(before);
  // An edit outside the window refolds nothing that is shown.
  const outside = edit(author, "absent", "Elsewhere", 4);
  expect(projection.reconcile([root, sibling, ignored, outside], [])).toBe(
    before,
  );

  const changed = projection.reconcile(
    [root, sibling, ignored, outside, edit(author, root.id, "Edited", 5)],
    [],
  );
  expect(changed).not.toBe(before);
  expect(changed[0]).toMatchObject({ content: "Edited", edited: true });
  expect(changed[1]).toBe(before[1]);
});
