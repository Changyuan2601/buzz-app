const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const unavailable = () =>
  new Error(
    "Current shared-session audience authority is unavailable or mismatched.",
  );

/** Capability identity comes from this connection's NIP-11, never an event author. */
export function audienceAuthorityCommunity(value: unknown): string | undefined {
  return record(value) &&
    value.version === 1 &&
    value.max_sources === 100 &&
    typeof value.community_id === "string" &&
    uuid.test(value.community_id)
    ? value.community_id
    : undefined;
}
export function audienceAuthorityFilter(
  destination: string,
  sources: readonly string[],
) {
  if (
    !uuid.test(destination) ||
    sources.length < 1 ||
    sources.length > 100 ||
    new Set(sources).size !== sources.length ||
    sources.some((id) => !uuid.test(id))
  )
    throw unavailable();
  return [
    {
      kinds: [39000, 39002],
      consistency: "strong",
      audience_authority: { version: 1, destination, sources: [...sources] },
    },
  ];
}
/** An ordinary event-array response cannot attest current membership or visibility. */
export function parseAudienceAuthority(
  raw: unknown,
  pubkey: string,
  community: string,
  destination: string,
  sources: readonly string[],
): ReadonlySet<string> {
  audienceAuthorityFilter(destination, sources);
  if (
    !/^[0-9a-f]{64}$/.test(pubkey) ||
    !uuid.test(community) ||
    !record(raw) ||
    Object.keys(raw).sort().join(",") !==
      "audience_authority,community_id,complete,destination,pubkey,sources" ||
    raw.audience_authority !== 1 ||
    raw.complete !== true ||
    raw.community_id !== community ||
    raw.pubkey !== pubkey ||
    raw.destination !== destination ||
    !Array.isArray(raw.sources) ||
    raw.sources.length !== sources.length
  )
    throw unavailable();
  const allowed = new Set<string>();
  raw.sources.forEach((item, i) => {
    if (
      !record(item) ||
      Object.keys(item).sort().join(",") !== "allowed,id" ||
      item.id !== sources[i] ||
      typeof item.allowed !== "boolean"
    )
      throw unavailable();
    if (item.allowed) allowed.add(item.id as string);
  });
  return allowed;
}
