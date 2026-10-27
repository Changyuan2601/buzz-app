import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import type { ReadTransport } from "../relay/transport";
import { keypair } from "../relay/testing";
import { communityDestination } from "./destination";
import { pageCommunities } from "./page";

const relays = vi.hoisted(() => ({ provide: vi.fn() }));
vi.mock("../relay/service", async (original) => {
  const actual = await original<typeof import("../relay/service")>();
  relays.provide.mockImplementation(actual.provideRelay);
  return { ...actual, provideRelay: relays.provide };
});

const roots: Context[] = [];
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose();
  relays.provide.mockClear();
});

const alpha = communityDestination("wss://alpha.example").id;
const beta = communityDestination("wss://beta.example").id;
function setup() {
  const viewer = keypair().pubkey;
  const relay = keypair().pubkey;
  const connected: string[] = [];
  const ctx = new Context();
  roots.push(ctx);
  const communities = pageCommunities(ctx, async (id) => {
    connected.push(id);
    return {
      viewer,
      relayAuthor: relay,
      scope: id,
      media: () => undefined,
      query: async () => [],
    } satisfies ReadTransport;
  });
  const changes = vi.fn();
  communities.subscribe(changes);
  return { viewer, communities, changes, connected };
}

it("opens nothing until the page that shows the communities sends them", () => {
  const { communities } = setup();
  expect(communities.snapshot()).toEqual({ memberships: [], selected: null });
  expect(communities.open(alpha)).toBeUndefined();
  // Signed out there: no viewer to connect as.
  communities.follow({ memberships: [alpha], selected: alpha });
  expect(communities.open(alpha)).toBeUndefined();
});

it("connects a joined community for its agents with a session that keeps nothing on the device", async () => {
  const { viewer, communities, changes, connected } = setup();
  communities.follow({ viewer, memberships: [alpha, beta], selected: beta });
  expect(changes).toHaveBeenCalledTimes(1);
  expect(communities.snapshot()).toEqual({
    viewer,
    memberships: [alpha, beta],
    selected: beta,
  });
  const relay = communities.open("wss://Alpha.example/");
  expect(relay).toBeDefined();
  expect(communities.open(alpha)).toBe(relay);
  expect(communities.open("wss://gamma.example")).toBeUndefined();
  await vi.waitFor(() => expect(connected).toEqual([alpha]));
  // No presence, nothing restored, and its sends and history in memory only.
  const [, , presence, , , saved, , options] =
    relays.provide.mock.calls[0] ?? [];
  expect({ presence, saved, options }).toEqual({
    presence: undefined,
    saved: undefined,
    options: { ephemeral: true },
  });
});

it("lets go of a community that is left, and of every one when the viewer changes", () => {
  const { viewer, communities } = setup();
  communities.follow({ viewer, memberships: [alpha, beta], selected: alpha });
  const first = communities.open(alpha);
  const second = communities.open(beta);
  communities.follow({ viewer, memberships: [beta], selected: null });
  expect(communities.open(alpha)).toBeUndefined();
  expect(communities.open(beta)).toBe(second);
  communities.follow({ viewer, memberships: [alpha, beta], selected: null });
  expect(communities.open(alpha)).not.toBe(first);
  communities.follow({
    viewer: keypair().pubkey,
    memberships: [alpha, beta],
    selected: null,
  });
  expect(communities.open(beta)).not.toBe(second);
});

it("tells its listeners only of what changed, and never selects a community it is not in", () => {
  const { viewer, communities, changes } = setup();
  communities.follow({ viewer, memberships: [alpha], selected: alpha });
  communities.follow({ viewer, memberships: [alpha], selected: alpha });
  expect(changes).toHaveBeenCalledTimes(1);
  communities.follow({ viewer, memberships: [alpha], selected: beta });
  expect(changes).toHaveBeenCalledTimes(2);
  expect(communities.snapshot().selected).toBeNull();
});
