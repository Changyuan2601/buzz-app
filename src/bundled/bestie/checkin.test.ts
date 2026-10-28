import { expect, it, vi } from "vitest";
import type { RelayEvent } from "../../features/relay/events";
import { readCheckIn } from "./checkin";

const signal = new AbortController().signal;

const BESTIE = "ab".repeat(32);
const HOME = "11111111-1111-4111-8111-111111111111";
const heartbeat = (overrides: Partial<RelayEvent> = {}) =>
  ({
    id: "cd".repeat(32),
    pubkey: BESTIE,
    kind: 30620,
    created_at: 1,
    content: "name: Bestie heartbeat\nenabled: true\n",
    tags: [
      ["d", "heartbeat"],
      ["h", HOME],
    ],
    sig: "ef".repeat(64),
    ...overrides,
  }) as RelayEvent;
const relay = (events: RelayEvent[], members = [BESTIE]) => ({
  read: vi.fn(async () => events),
  channelWrites: {
    refreshMembership: vi.fn(async () => ({ members })),
  },
});
const reads = (session: ReturnType<typeof relay>) =>
  readCheckIn(
    session as unknown as Parameters<typeof readCheckIn>[0],
    BESTIE,
    HOME,
    signal,
  );

it("reads check-in as on when Bestie's heartbeat is in its home and Bestie is a member", async () => {
  const session = relay([heartbeat()]);
  expect(await reads(session)).toBe(true);
  expect(session.read).toHaveBeenCalledWith(
    [
      {
        kinds: [30620],
        authors: [BESTIE],
        "#h": [HOME],
        limit: 20,
        consistency: "strong",
      },
    ],
    { fresh: true, signal },
  );
});
it("reads check-in as off without a heartbeat signed by Bestie in its home", async () => {
  expect(await reads(relay([]))).toBe(false);
  expect(await reads(relay([heartbeat({ pubkey: "12".repeat(32) })]))).toBe(
    false,
  );
  expect(
    await reads(
      relay([
        heartbeat({
          tags: [
            ["d", "heartbeat"],
            ["h", "22222222-2222-4222-8222-222222222222"],
          ],
        }),
      ]),
    ),
  ).toBe(false);
  expect(
    await reads(relay([heartbeat({ content: "name: Something else\n" })])),
  ).toBe(false);
});
it("reads check-in as off once Bestie has left its home", async () => {
  expect(await reads(relay([heartbeat()], ["12".repeat(32)]))).toBe(false);
});
