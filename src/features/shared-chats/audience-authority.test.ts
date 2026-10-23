import { expect, it } from "vitest";
import {
  audienceAuthorityCommunity,
  audienceAuthorityFilter,
  parseAudienceAuthority,
} from "./audience-authority";
const community = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const source = "33333333-3333-4333-8333-333333333333";
const viewer = "a".repeat(64);
const response = () => ({
  audience_authority: 1,
  complete: true,
  community_id: community,
  pubkey: viewer,
  destination,
  sources: [{ id: source, allowed: true }],
});
it("uses a bounded explicit query extension and a connection-advertised capability", () => {
  expect(
    audienceAuthorityCommunity({
      version: 1,
      community_id: community,
      max_sources: 100,
    }),
  ).toBe(community);
  expect(
    audienceAuthorityCommunity({
      version: 2,
      community_id: community,
      max_sources: 100,
    }),
  ).toBeUndefined();
  expect(
    audienceAuthorityCommunity({ version: 1, community_id: community }),
  ).toBeUndefined();
  expect(audienceAuthorityFilter(destination, [source])).toEqual([
    {
      kinds: [39000, 39002],
      consistency: "strong",
      audience_authority: { version: 1, destination, sources: [source] },
    },
  ]);
  expect([
    ...parseAudienceAuthority(response(), viewer, community, destination, [
      source,
    ]),
  ]).toEqual([source]);
  expect([
    ...parseAudienceAuthority(
      { ...response(), sources: [{ id: source, allowed: false }] },
      viewer,
      community,
      destination,
      [source],
    ),
  ]).toEqual([]);
});
it.each([
  [],
  { ...response(), audience_authority: 2 },
  { ...response(), complete: false },
  { ...response(), community_id: destination },
  { ...response(), pubkey: "b".repeat(64) },
  { ...response(), destination: source },
  { ...response(), sources: [] },
  { ...response(), sources: [{ id: destination, allowed: true }] },
  { ...response(), sources: [{ id: source, allowed: "true" }] },
  {
    ...response(),
    sources: [
      { id: source, allowed: true },
      { id: source, allowed: true },
    ],
  },
])("rejects unsupported, incomplete or misbound authority: %j", (raw) => {
  expect(() =>
    parseAudienceAuthority(raw, viewer, community, destination, [source]),
  ).toThrow(/authority/);
});
it.each(
  [
    [],
    [source, source],
    Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
    ),
    ["not-a-channel"],
  ].map((sources) => [sources] as const),
)("rejects invalid request bounds: %j", (sources) => {
  expect(() => audienceAuthorityFilter(destination, sources)).toThrow(
    /authority/,
  );
});
