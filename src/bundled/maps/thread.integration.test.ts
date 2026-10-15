import { expect, it } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { LiveCallbacks } from "../../features/relay/live";
import {
  bounds,
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
} from "../../features/relay/testing";

it("projects a live channel reply into the owned thread, not the channel timeline", async () => {
  const viewer = keypair(),
    relay = keypair(),
    author = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let traffic!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      traffic = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const root = message(viewer, "map", "Question", 1);
  const response = message(author, "map", "Answer", 2, [
    ["e", root.id, "", "reply"],
  ]);
  try {
    traffic.receive([
      roster(relay, "map", [viewer.pubkey, author.pubkey]),
      root,
    ]);
    owner.session.channels.ensure("map");
    wire
      .next()
      .respond([
        root,
        bounds(relay, "map", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    const thread = owner.session.thread("map", root.id);
    try {
      traffic.receive([response]);
      expect(
        owner.session.channels.window("map").rows.map((row) => row.id),
      ).toEqual([root.id]);
      expect(thread.snapshot().replies.map((row) => row.id)).toEqual([
        response.id,
      ]);
    } finally {
      thread.dispose();
    }
  } finally {
    owner.dispose();
  }
});
