import { afterEach, expect, it } from "vitest";
import { createRelaySession } from "./session";
import { flush, keypair, scriptedTransport, signed, type Key } from "./testing";
import type { LiveCallbacks } from "./live";
import type { RelayEvent } from "./events";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const held = "a".repeat(64),
  unknown = "b".repeat(64);
const deletion = (tags: string[][], author: Key = viewer) =>
  signed(author, { kind: 5, content: "", tags });
const admitted = deletion([
  ["e", held],
  ["k", "44300"],
]);
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function harness() {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    scope: "https://one.example",
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  live.state({ status: "connected", routes: [] });
  const seen: RelayEvent[] = [];
  owner.session.subscribeLive((batch) => {
    seen.push(...batch.events);
  });
  const stop = owner.session.admitInstructionsDeletions((id) => id === held);
  return { ...owner, wire, live, seen, stop };
}
const backfill = async (
  h: ReturnType<typeof harness>,
  events: RelayEvent[],
) => {
  const read = h.session.read([
    { kinds: [5], authors: [viewer.pubkey], limit: 10 },
  ]);
  await flush();
  h.wire.next().respond(events);
  return (await read).map((event) => event.id);
};

it("T23 admits the owner's k=44300 deletion of a held version, live and in backfill", async () => {
  const h = harness();
  h.live.receive([admitted], { phase: "live" });
  await flush();
  expect(h.seen.map((event) => event.id)).toContain(admitted.id);
  expect(await backfill(h, [admitted])).toEqual([admitted.id]);
});

it.each([
  [
    "by another author",
    deletion(
      [
        ["e", held],
        ["k", "44300"],
      ],
      other,
    ),
  ],
  [
    "with an h tag",
    deletion([
      ["e", held],
      ["k", "44300"],
      ["h", "c"],
    ]),
  ],
  [
    "with a mixed k",
    deletion([
      ["e", held],
      ["k", "44300"],
      ["k", "7"],
    ]),
  ],
  [
    "of a target not held",
    deletion([
      ["e", unknown],
      ["k", "44300"],
    ]),
  ],
  [
    "with one target not held",
    deletion([
      ["e", held],
      ["e", unknown],
      ["k", "44300"],
    ]),
  ],
])("T24 does not admit a deletion %s", async (_name, event) => {
  const h = harness();
  h.live.receive([event], { phase: "live" });
  await flush();
  expect(h.seen.map((item) => item.id)).not.toContain(event.id);
  expect(await backfill(h, [event])).toEqual([]);
});

it("T24 stops admitting once the instructions store lets go", async () => {
  const h = harness();
  h.stop();
  h.live.receive([admitted], { phase: "live" });
  await flush();
  expect(h.seen.map((event) => event.id)).not.toContain(admitted.id);
});
