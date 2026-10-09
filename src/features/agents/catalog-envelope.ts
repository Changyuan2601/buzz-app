/** NIP-AP catalog envelope rules shared by the app and the dev signing broker.
 * Dependency-free so the broker's config can load it natively. */
export const AGENT_CATALOG_KIND = 30175;
export const TEAM_CATALOG_KIND = 30178;
export const MAX_CONTENT_BYTES = 65_535;
/** Serialized catalog event or template bound. Content is JSON text, which JSON
 * string escaping at most doubles; the rest covers keys, the bounded tags, id,
 * pubkey and signature. Mirrored by the native signer. */
export const MAX_EVENT_BYTES = 2 * MAX_CONTENT_BYTES + 2048;
export const isCatalogKind = (kind: unknown) =>
  kind === AGENT_CATALOG_KIND || kind === TEAM_CATALOG_KIND;

export type Body = Record<string, unknown>;
export const bytes = (value: string) => new TextEncoder().encode(value).length;

export function object(content: string): Body | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Body)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Signer admission, mirrored by the native validator: exactly one `d`, at most
 * one exact `["shared","true"]` and one `client-id`, and no `env_vars` body. */
export function validCatalogEnvelope(event: {
  kind?: unknown;
  content?: unknown;
  tags?: unknown;
  created_at?: unknown;
}): boolean {
  const { kind, content, tags, created_at } = event;
  if (
    (kind !== AGENT_CATALOG_KIND && kind !== TEAM_CATALOG_KIND) ||
    typeof content !== "string" ||
    bytes(content) > MAX_CONTENT_BYTES ||
    !Number.isSafeInteger(created_at) ||
    !Array.isArray(tags)
  )
    return false;
  const count = (name: string) =>
    tags.filter((tag) => Array.isArray(tag) && tag[0] === name).length;
  if (count("d") !== 1 || count("shared") > 1 || count("client-id") > 1)
    return false;
  const tagsOk = tags.every(
    (tag) =>
      Array.isArray(tag) &&
      tag.length === 2 &&
      typeof tag[1] === "string" &&
      (tag[0] === "d"
        ? kind === AGENT_CATALOG_KIND
          ? /^[a-z0-9][a-z0-9_-]{0,63}$/.test(tag[1])
          : !!tag[1] && [...tag[1]].length <= 64 && !/[\s\p{Cc}]/u.test(tag[1])
        : tag[0] === "shared"
          ? tag[1] === "true"
          : tag[0] === "client-id" && tag[1].length <= 128),
  );
  const body = tagsOk ? object(content) : undefined;
  if (!body || "env_vars" in body) return false;
  const name = kind === AGENT_CATALOG_KIND ? body.display_name : body.name;
  return (
    typeof name === "string" &&
    !!name.trim() &&
    (kind === AGENT_CATALOG_KIND || Array.isArray(body.members))
  );
}
