import { expect, it } from "vitest";
import type { EventData } from "./events";
import { foldMessages } from "./fold";
import { createMessageFold } from "./incremental-fold";

const channel = "chan-1";

it("folds changing evidence incrementally exactly as a full fold", () => {
  let state = 1;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const pick = <T>(values: readonly T[]) =>
    values[Math.floor(random() * values.length)] as T;
  const hex = (value: number) => value.toString(16).padStart(64, "0");
  const authority = hex(1);
  const people = [hex(2), hex(3), hex(4), authority];
  const contents = [
    "Plain reply",
    "**Bold** with ![chart](https://example.com/chart.png)",
    "See [notes.pdf](https://example.com/notes.pdf)",
    ":party:",
    "👍",
  ];
  for (let seed = 1; seed <= 40; seed++) {
    state = seed;
    let next = 16;
    const pool: EventData[] = [];
    const event = (kind: number, content: string, tags: string[][]) => {
      const created = {
        id: hex(next++),
        pubkey: pick(people),
        created_at: 100 + Math.floor(random() * 20),
        kind,
        content,
        tags,
      };
      pool.push(created);
      return created;
    };
    const root = event(9, "Root", [["h", channel]]);
    for (let index = 0; index < 60; index++) {
      const target = pick(pool);
      const roll = random();
      if (roll < 0.3)
        event(random() < 0.8 ? 9 : 40002, pick(contents), [
          ["h", channel],
          ...(random() < 0.3 ? [["actor", pick(people)]] : []),
          ["e", root.id, "", "root"],
          ["e", target.id, "", "reply"],
          ...(random() < 0.2
            ? [["imeta", "url https://example.com/notes.pdf", "m text/pdf"]]
            : []),
        ]);
      else if (roll < 0.5)
        event(40003, pick(contents), [
          ["e", target.id],
          ["h", channel],
          ...(random() < 0.3
            ? [["imeta", "url https://example.com/notes.pdf"]]
            : []),
        ]);
      else if (roll < 0.65)
        event(7, pick(contents), [
          ["e", target.id],
          ...(random() < 0.3
            ? [["emoji", "party", "https://example.com/party.png"]]
            : []),
        ]);
      else if (roll < 0.8)
        event(pick([5, 9005]), "", [
          ["e", target.id],
          ...(random() < 0.5 ? [["h", channel]] : []),
          ...(random() < 0.3 ? [["k", String(target.kind)]] : []),
        ]);
      else if (roll < 0.9)
        event(
          39005,
          JSON.stringify({
            reply_count: Math.floor(random() * 9),
            participants: [pick(people)],
          }),
          [["e", target.id]],
        );
      else
        event(
          pick([48100, 48103]),
          JSON.stringify({
            ephemeral_channel_id: "8c4f7d2e-5b1a-4c3d-9e8f-0a1b2c3d4e5f",
          }),
          [["h", channel]],
        );
    }
    const fold = createMessageFold(channel, authority, {
      includeReplies: true,
      signingAuthority: authority,
    });
    let present = pool.filter(() => random() < 0.5);
    let owners = new Map<string, string>();
    for (let step = 0; step < 30; step++) {
      present = [
        ...present.filter(() => random() < 0.9),
        ...pool.filter((item) => !present.includes(item) && random() < 0.15),
      ];
      if (random() < 0.2) present = [...present].reverse();
      if (random() < 0.3)
        owners = new Map(people.map((pubkey) => [pubkey, pick(people)]));
      const consulted = () => {
        const looked = new Map<string, string | undefined>();
        return [
          looked,
          (pubkey: string) => {
            looked.set(pubkey, owners.get(pubkey));
            return owners.get(pubkey);
          },
        ] as const;
      };
      const [expectedLooked, expectedOwner] = consulted();
      const expected = foldMessages(channel, authority, present, {
        includeReplies: true,
        signingAuthority: authority,
        agentOwner: expectedOwner,
      });
      const [looked, owner] = consulted();
      const rows = fold(present, owner);
      expect(rows).toStrictEqual(expected);
      expect(looked).toEqual(expectedLooked);
      const again = fold(present, owner);
      expect(again).toHaveLength(rows.length);
      // Collapsing rebuilds huddle starts that carry their end.
      for (const [index, row] of again.entries())
        if (!row.huddle) expect(row).toBe(rows[index]);
    }
  }
});
