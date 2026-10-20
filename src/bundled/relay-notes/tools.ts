// NIP-23 notes use the same finite reads and agent-held signer as other tools.
import { decode, naddrEncode } from "nostr-tools/nip19";
import type { BuzzClient, BuzzEvent, Filter } from "../../buzz-mcp/client";

type Args = Readonly<Record<string, unknown>>;
const KIND = 30023;
const HEX = /^[0-9a-f]{64}$/;
const tag = (event: BuzzEvent, key: string) =>
  event.tags.find((entry) => entry[0] === key)?.[1];
const string = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a nonempty string.`);
  return value;
};
function slug(value: string) {
  if (!/^[a-z0-9._-]{1,80}$/.test(value))
    throw new Error(
      "Use a slug of 1–80 lowercase letters, digits, dots, underscores or hyphens.",
    );
  return value;
}
function author(value: unknown) {
  const input = string(value, "author");
  if (HEX.test(input.toLowerCase())) return input.toLowerCase();
  const parsed = decode(input);
  if (parsed.type !== "npub")
    throw new Error("author must be a hex pubkey or npub.");
  return parsed.data;
}
function target(value: unknown, own: string) {
  const input = string(value, "note").replace(/^nostr:/, "");
  if (input.startsWith("naddr1")) {
    const parsed = decode(input);
    if (parsed.type !== "naddr" || parsed.data.kind !== KIND)
      throw new Error("Use a NIP-23 (30023) naddr.");
    return {
      pubkey: parsed.data.pubkey,
      identifier: parsed.data.identifier,
    };
  }
  const coordinate = /^30023:([0-9a-fA-F]{64}):(.*)$/s.exec(input);
  if (coordinate)
    return {
      pubkey: (coordinate[1] ?? "").toLowerCase(),
      identifier: coordinate[2] ?? "",
    };
  return { pubkey: own, identifier: slug(input) };
}
function reference(event: BuzzEvent) {
  const id = tag(event, "d") ?? "";
  return {
    coordinate: `${KIND}:${event.pubkey}:${id}`,
    naddr: naddrEncode({ kind: KIND, pubkey: event.pubkey, identifier: id }),
    event_id: event.id,
    author: event.pubkey,
    title: tag(event, "title") ?? "",
    updated_at: event.created_at,
  };
}
async function head(
  client: BuzzClient,
  place: ReturnType<typeof target>,
  strong = false,
) {
  const events = await client.query([
    {
      kinds: [KIND],
      authors: [place.pubkey],
      "#d": [place.identifier],
      limit: 1,
      ...(strong ? { consistency: "strong" } : {}),
    },
  ]);
  return events
    .filter(
      (event) =>
        event.kind === KIND &&
        event.pubkey === place.pubkey &&
        tag(event, "d") === place.identifier,
    )
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

export async function listNotes(client: BuzzClient, args: Args) {
  if (
    Object.keys(args).some(
      (key) => !["author", "q", "before", "limit"].includes(key),
    )
  )
    throw new Error("Unknown notes argument.");
  const limit = args.limit ?? 20;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("limit must be an integer from 1 to 100.");
  const filter: Record<string, unknown> = {
    kinds: [KIND],
    authors: [args.author === undefined ? client.pubkey : author(args.author)],
    limit,
  };
  if (args.q !== undefined) filter.search = string(args.q, "q");
  if (args.before !== undefined) {
    if (
      typeof args.before !== "number" ||
      !Number.isSafeInteger(args.before) ||
      args.before < 0
    )
      throw new Error("before must be nonnegative Unix seconds (inclusive).");
    filter.until = args.before;
  }
  const events = await client.query([filter as Filter]);
  return JSON.stringify({
    notes: events
      .filter(
        (event) =>
          event.kind === KIND &&
          tag(event, "d") &&
          event.pubkey === (filter.authors as string[])[0],
      )
      .slice(0, limit)
      .map(reference),
    partial: events.length >= limit,
    guidance:
      "Bounded relay results, not an exhaustive catalog. Narrow by author or q; before is inclusive and may repeat boundary results. Read a known coordinate directly.",
  });
}

export async function note(client: BuzzClient, args: Args) {
  const action = args.action ?? "read";
  if (action !== "read" && action !== "save")
    throw new Error("action must be read or save.");
  const fields =
    action === "read"
      ? ["action", "note"]
      : ["action", "note", "title", "text", "path", "expected_event"];
  if (Object.keys(args).some((key) => !fields.includes(key)))
    throw new Error(`Unexpected argument for note ${action}.`);
  const place = target(args.note, client.pubkey);
  if (action === "read") {
    const current = await head(client, place);
    if (!current) throw new Error("Note not found or not accessible.");
    return JSON.stringify({ ...reference(current), text: current.content });
  }
  if (place.pubkey !== client.pubkey)
    throw new Error("You can save only your own notes.");
  slug(place.identifier);
  const title = string(args.title, "title");
  if (title.length > 300)
    throw new Error("title must be at most 300 characters.");
  const expected = string(args.expected_event, "expected_event");
  if (expected !== "absent" && !HEX.test(expected))
    throw new Error(
      "expected_event must be the event ID read, or absent for a new note.",
    );
  if ((args.text !== undefined) === (args.path !== undefined))
    throw new Error("Give exactly one of text or path.");
  const body =
    args.path !== undefined
      ? new TextDecoder("utf-8", { fatal: true }).decode(
          await client.read(string(args.path, "path")),
        )
      : string(args.text, "text");
  if (new TextEncoder().encode(body).length > 64 * 1024)
    throw new Error("Note content must be at most 64 KiB.");
  const current = await head(client, place, true);
  if ((current?.id ?? "absent") !== expected)
    throw new Error(
      `Note changed; read it again before saving (current: ${current?.id ?? "absent"}).`,
    );
  // The native signer chooses seconds. Publishing at the head's second can lose
  // NIP-01's ID tie-break, so refuse rather than silently discard an edit.
  const now = Math.floor(Date.now() / 1000);
  if (current && current.created_at >= now)
    throw new Error(
      "Note timestamp has not passed; retry after its updated_at second.",
    );
  const tags = current?.tags.filter(
    (entry) => !["d", "title", "auth", "ms"].includes(entry[0] ?? ""),
  ) ?? [["published_at", String(now)]];
  const saved = await client.publish({
    kind: KIND,
    content: body,
    tags: [["d", place.identifier], ["title", title], ...tags],
  });
  try {
    const shown = await head(client, place, true);
    return JSON.stringify({
      ...reference(saved),
      status: shown?.id === saved.id ? "confirmed" : "accepted_unconfirmed",
      ...(shown?.id !== saved.id
        ? {
            message:
              "Accepted, but the latest relay read does not select this event. Read again before editing; do not blindly repeat the save.",
          }
        : {}),
    });
  } catch {
    return JSON.stringify({
      ...reference(saved),
      status: "accepted_unconfirmed",
      message:
        "Accepted, but readback failed. Read again before editing; do not blindly repeat the save.",
    });
  }
}
