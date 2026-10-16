import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "./events";
import { createRelaySession } from "./session";
import { keypair } from "./testing";

const viewer = keypair(),
  relay = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

// The relay clamps a missing limit to 100 and any limit to 1000, so a full
// page must equal the caller's limit. The shared reader caps at 500.
it("refuses snapshot filters without a limit or above the read cap, before any request", async () => {
  const query = vi.fn(async () => [] as RelayEvent[]);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query,
    subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
  });
  owners.push(owner);
  const read = owner.session.snapshotRead;
  if (!read) throw new Error("snapshotRead unavailable");
  const signal = new AbortController().signal;
  await expect(read([{ kinds: [45010] } as never], { signal })).rejects.toThrow(
    /limit/,
  );
  await expect(
    read(
      [
        { kinds: [45010], limit: 16 },
        { kinds: [39000], limit: 501 },
      ],
      {
        signal,
      },
    ),
  ).rejects.toThrow(/limit/);
  expect(query).not.toHaveBeenCalled();
  await read([{ kinds: [45010], limit: 500 }], { signal });
  expect(query).toHaveBeenCalledTimes(1);
});
