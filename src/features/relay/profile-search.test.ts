import { expect, it, vi } from "vitest";
import { ReadError } from "./errors";
import type { ReadFilter, RelayEvent } from "./events";
import {
  createProfileSearch,
  PROFILE_SEARCH_QUERY_MAX,
  PROFILE_SEARCH_RETRY_MS,
} from "./profile-search";
import type { ReadOptions } from "./reader";
import { keypair, signed } from "./testing";

const profiles = Array.from({ length: 5 }, (_, index) =>
  signed(keypair(), {
    kind: 0,
    content: JSON.stringify({ name: `Wes ${index}` }),
    tags: [],
  }),
);
const nip50 = signed(keypair(), {
  kind: 0,
  content: JSON.stringify({ name: "Westie" }),
  tags: [],
});

function setup(
  search?: (
    query: string,
    limit: number,
    page: number,
  ) => Promise<RelayEvent[]>,
) {
  const reads: ReadFilter[][] = [];
  const endpoint = search
    ? vi.fn(
        (query: string, limit: number, page: number, _options?: ReadOptions) =>
          search(query, limit, page),
      )
    : undefined;
  const fallback = {
    read: vi.fn(async (filters: readonly ReadFilter[]) => {
      reads.push([...filters]);
      return [nip50];
    }),
    ...(endpoint ? { searchProfiles: endpoint } : {}),
  };
  const clock = { now: 1_000_000 };
  const searchProfiles = createProfileSearch(fallback, () => clock.now);
  return { searchProfiles, endpoint, fallback, reads, clock };
}

const signal = () => new AbortController().signal;

it("asks the name-only endpoint and never sends NIP-50 search", async () => {
  const { searchProfiles, endpoint, reads } = setup(async () => profiles);
  expect(
    await searchProfiles(" wes ", { limit: 40, signal: signal() }),
  ).toEqual(profiles);
  expect(endpoint).toHaveBeenCalledWith("wes", 40, 1, {
    signal: expect.any(AbortSignal),
    priority: "foreground",
    fresh: true,
  });
  expect(reads).toEqual([]);
});

it("passes the requested page to the endpoint", async () => {
  const { searchProfiles, endpoint } = setup(async (_, limit, page) =>
    profiles.slice((page - 1) * limit, page * limit),
  );
  expect(
    await searchProfiles("wes", { limit: 2, page: 2, signal: signal() }),
  ).toEqual(profiles.slice(2, 4));
  expect(endpoint).toHaveBeenLastCalledWith("wes", 2, 2, {
    signal: expect.any(AbortSignal),
    priority: "foreground",
    fresh: true,
  });
  // No total cap: a page past the first hundred results still reaches the relay.
  await searchProfiles("wes", { limit: 30, page: 5, signal: signal() });
  expect(endpoint).toHaveBeenLastCalledWith("wes", 30, 5, {
    signal: expect.any(AbortSignal),
    priority: "foreground",
    fresh: true,
  });
});

it.each([404, 405])(
  "uses NIP-50 search for a while on a relay that answers %i, then retries",
  async (status) => {
    let missing = true;
    const { searchProfiles, endpoint, reads, clock } = setup(async () => {
      if (missing) throw new ReadError("unavailable", "missing", status);
      return profiles;
    });
    expect(
      await searchProfiles("wes", { limit: 30, page: 2, signal: signal() }),
    ).toEqual([nip50]);
    clock.now += PROFILE_SEARCH_RETRY_MS - 1;
    expect(await searchProfiles("we", { limit: 40, signal: signal() })).toEqual(
      [nip50],
    );
    expect(endpoint).toHaveBeenCalledTimes(1);
    expect(reads).toEqual([
      [
        {
          kinds: [0],
          search: "wes",
          search_mode: "prefix",
          limit: 30,
          page: 2,
        },
      ],
      [{ kinds: [0], search: "we", search_mode: "prefix", limit: 40 }],
    ]);
    // The relay was upgraded meanwhile: the next search after the wait uses it.
    missing = false;
    clock.now += 1;
    expect(
      await searchProfiles("wes", { limit: 40, signal: signal() }),
    ).toEqual(profiles);
    expect(endpoint).toHaveBeenCalledTimes(2);
    expect(reads).toHaveLength(2);
  },
);

it("reports other endpoint failures instead of hiding them behind NIP-50", async () => {
  for (const status of [401, 429, 500]) {
    const { searchProfiles, reads } = setup(async () => {
      throw new ReadError("unavailable", "failed", status);
    });
    await expect(
      searchProfiles("wes", { limit: 40, signal: signal() }),
    ).rejects.toMatchObject({ status });
    expect(reads).toEqual([]);
  }
});

it("falls back when a relay that served the endpoint loses it", async () => {
  let missing = false;
  const { searchProfiles, reads } = setup(async () => {
    if (missing) throw new ReadError("unavailable", "missing", 404);
    return profiles;
  });
  await searchProfiles("wes", { limit: 40, signal: signal() });
  missing = true;
  expect(await searchProfiles("wes", { limit: 40, signal: signal() })).toEqual([
    nip50,
  ]);
  expect(reads).toEqual([
    [{ kinds: [0], search: "wes", search_mode: "prefix", limit: 40 }],
  ]);
});

it("sends a query over the relay's character limit to NIP-50 search", async () => {
  const { searchProfiles, endpoint, reads } = setup(async () => profiles);
  // Code points, not UTF-16 units: 100 emoji are 200 units and still fit.
  const longest = "😀".repeat(PROFILE_SEARCH_QUERY_MAX);
  await searchProfiles(` ${longest} `, { limit: 40, signal: signal() });
  expect(endpoint).toHaveBeenCalledTimes(1);
  expect(endpoint).toHaveBeenLastCalledWith(longest, 40, 1, expect.anything());
  const over = "w".repeat(PROFILE_SEARCH_QUERY_MAX + 1);
  expect(await searchProfiles(over, { limit: 40, signal: signal() })).toEqual([
    nip50,
  ]);
  expect(endpoint).toHaveBeenCalledTimes(1);
  expect(reads).toEqual([
    [{ kinds: [0], search: over, search_mode: "prefix", limit: 40 }],
  ]);
  // Not a missing endpoint: the next short query uses it right away.
  await searchProfiles("wes", { limit: 40, signal: signal() });
  expect(endpoint).toHaveBeenCalledTimes(2);
});

it("keeps non-profile events out of the result", async () => {
  const message = signed(keypair(), { kind: 9, content: "wes", tags: [] });
  const { searchProfiles } = setup(async () => [message, ...profiles]);
  expect(await searchProfiles("wes", { limit: 40, signal: signal() })).toEqual(
    profiles,
  );
});

it("uses NIP-50 search when the transport has no endpoint", async () => {
  const { searchProfiles, reads } = setup();
  expect(await searchProfiles("wes", { limit: 15, signal: signal() })).toEqual([
    nip50,
  ]);
  expect(reads).toEqual([
    [{ kinds: [0], search: "wes", search_mode: "prefix", limit: 15 }],
  ]);
});
