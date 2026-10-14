import { expect, it } from "vitest";
import type { ReadFilter } from "../relay/events";
import {
  CATCH_UP_PAGE,
  CATCH_UP_PAGES,
  readWindow,
  type Stream,
} from "./catch-up";

type Stored = { id: string; created_at: number; content: string };
const id = (i: number) => i.toString(16).padStart(64, "0");
/** A relay's page: newest first, ties by id ascending, below the cursor. */
const relay = (events: readonly Stored[]) => {
  const reads: ReadFilter[] = [];
  const read = async (filter: ReadFilter) => {
    reads.push(filter);
    const until = filter.until ?? Number.MAX_SAFE_INTEGER;
    return events
      .filter(
        (event) =>
          event.created_at >= (filter.since ?? 0) &&
          (event.created_at < until ||
            (event.created_at === until &&
              (filter.before_id === undefined || event.id > filter.before_id))),
      )
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
      .slice(0, filter.limit);
  };
  return { read, reads };
};
/** A watch on every channel: the bound applies there too. */
const all: Stream = {
  key: "k",
  slug: "watch/all",
  since: 1,
  enabled: true,
};

it("reads a whole window and gives it oldest first, ties by id", async () => {
  // Two events a second, stored out of order.
  const events = Array.from({ length: 40 }, (_, i) => ({
    id: id(i),
    created_at: 100 + Math.floor(i / 2),
    content: `m${i}`,
  })).reverse();
  const { read, reads } = relay(events);
  const window = await readWindow(all, undefined, 500, read);
  expect(window?.skipped).toBe(false);
  expect(window?.events.map(({ content }) => content)).toEqual(
    Array.from({ length: 40 }, (_, i) => `m${i}`),
  );
  // No channel and no tags: the relay filters most tags after its limit.
  expect(reads[0]).toEqual({ kinds: [9], since: 1, until: 500, limit: 16 });
  expect(reads).toHaveLength(4);
  expect(window?.checkpoint).toEqual({ through: 0, upper: 500 });
});

it("stops after its page bound on every channel, skipping the oldest second it reached whole", async () => {
  const total = CATCH_UP_PAGES * CATCH_UP_PAGE + 100;
  const events = Array.from({ length: total }, (_, i) => ({
    id: id(i),
    created_at: 1000 + Math.floor(i / 2),
    content: `m${i}`,
  }));
  const { read, reads } = relay(events);
  const window = await readWindow(all, undefined, 1_000_000, read);
  // 256 full pages, then one event to learn that older ones are left.
  expect(reads).toHaveLength(CATCH_UP_PAGES + 1);
  expect(reads.at(-1)?.limit).toBe(1);
  // The last page read reached i = 100, at second 1050; its partner i = 101
  // was read too, but all of second 1050 is skipped with everything older.
  expect(window?.skipped).toBe(true);
  expect(window?.events[0]?.content).toBe("m102");
  expect(window?.events.at(-1)?.content).toBe(`m${total - 1}`);
  expect(window?.events).toHaveLength(total - 102);
  expect(window?.checkpoint).toEqual({ through: 1050, upper: 1_000_000 });
  // What is left is read no more: the next window starts after it.
  const again = await readWindow(all, window?.checkpoint, 1_000_000, read);
  expect(again?.events).toHaveLength(total - 102);
  expect(again?.skipped).toBe(false);
});

it("stops after its byte bound too", async () => {
  const big = "x".repeat(256 * 1024);
  const events = Array.from({ length: 64 }, (_, i) => ({
    id: id(i),
    created_at: 1000 + i,
    content: big,
  }));
  const { read } = relay(events);
  const window = await readWindow(all, undefined, 1_000_000, read);
  expect(window?.skipped).toBe(true);
  // Two pages, past 8 MiB, then the oldest second reached is skipped.
  expect(window?.events).toHaveLength(31);
  expect(window?.events[0]?.created_at).toBe(1000 + 33);
});

it("goes on after the last event delivered when a window was cut short", async () => {
  const events = Array.from({ length: 20 }, (_, i) => ({
    id: id(i),
    created_at: 100 + i,
    content: `m${i}`,
  }));
  const { read } = relay(events);
  const window = await readWindow(
    all,
    { through: 0, upper: 500, after: { created_at: 109, id: id(9) } },
    900,
    read,
  );
  expect(window?.upper).toBe(500);
  expect(window?.events.map(({ content }) => content)).toEqual(
    Array.from({ length: 10 }, (_, i) => `m${i + 10}`),
  );
});
