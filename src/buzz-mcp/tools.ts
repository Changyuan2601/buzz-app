// The Buzz tools: what an agent does in Buzz, in the wire formats the `buzz`
// CLI writes. Names, arguments and descriptions are kept short because every
// session pays for them in context. Each tool answers in plain text.
import { decode } from "nostr-tools/nip19";
import {
  canonicalDetailsName,
  detailsDraftErrors,
} from "../features/relay/channel-details-protocol";
import {
  lifecycleChannelId,
  lifecycleTemplate,
} from "../features/relay/channel-lifecycle-protocol";
import {
  PROFILE_SEARCH_MAX,
  PROFILE_SEARCH_QUERY_MAX,
} from "../features/relay/profile-search";
import {
  listSharedSessions,
  readSharedSession,
} from "../features/sessions/shared-sessions";
import {
  attachmentMarkdown,
  attachmentName,
} from "../features/relay/attachments";
import { threadReference } from "../features/relay/thread-reference";
import {
  CHOICE_OPTIONS_MAX,
  CHOICE_OPTIONS_MIN,
  inlineUiContent,
  PATTERNS,
  readInlineUi,
  UI_TAG,
} from "../features/inline-ui/patterns";
import type { BuzzClient, BuzzEvent, Context, Filter, Upload } from "./client";

const ROLES = ["owner", "admin", "member", "guest", "bot"];
const str = { type: "string" } as const;
const strs = { type: "array", items: str } as const;
const tool = (
  name: string,
  description: string,
  properties: Readonly<Record<string, object>>,
  required: readonly string[] = [],
) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  },
});

export type Tool = ReturnType<typeof tool>;
export const TOOLS: readonly Tool[] = [
  tool(
    "send",
    "Post a message. Without channel, replies in the current thread. A reply goes in its message's thread.",
    {
      text: str,
      path: str,
      channel: str,
      reply: str,
      files: strs,
      mentions: strs,
      audience: {
        type: "string",
        enum: ["everyone", "agents"],
        description:
          "agents: only other agents need this (delegating, asking or answering an agent)",
      },
      final: {
        type: "boolean",
        description: "Your last message this turn; ends the turn.",
      },
      ui: {
        type: "object",
        description:
          "Answers under your text in the Buzz app, for a question with a few clear answers; they pick one or write their own. Text is the question. Other clients get a numbered list. pattern profile offers names for yourself beside an avatar picker; use it only when Buzz asks.",
        properties: {
          pattern: { type: "string", enum: [...PATTERNS] },
          options: {
            type: "array",
            items: str,
            minItems: CHOICE_OPTIONS_MIN,
            maxItems: CHOICE_OPTIONS_MAX,
          },
        },
        required: ["pattern", "options"],
        additionalProperties: false,
      },
    },
    ["audience"],
  ),
  tool("edit", "Edit your message.", { id: str, text: str }, ["id", "text"]),
  tool(
    "react",
    "React to a message.",
    { id: str, emoji: str, off: { type: "boolean" } },
    ["id", "emoji"],
  ),
  tool(
    "read",
    "Read a thread (default: current), a channel's latest, or search with q.",
    {
      channel: str,
      thread: str,
      q: str,
      author: {
        type: "string",
        description: "With q or channel: only this hex pubkey or npub.",
      },
      since: {
        type: "integer",
        description: "With q or channel: Unix seconds, at or after.",
      },
      before: { type: "integer", description: "Unix seconds, at or before." },
      before_id: {
        type: "string",
        description: "For paginating: with before, from a continue line.",
      },
      limit: {
        type: "integer",
        description: "Search 20 (max 100), thread 100 (500), channel 30 (200).",
      },
    },
  ),
  tool(
    "shared_sessions",
    "List shared sessions in the current channel, or read a source for an answer here. Checks current audience access. Titles are clues, not exhaustive content search.",
    {
      action: { type: "string", enum: ["list", "read"] },
      source: str,
      share_ids: {
        type: "array",
        items: { type: "string", pattern: "^[0-9a-f]{64}$" },
        minItems: 1,
        maxItems: 32,
        uniqueItems: true,
        description:
          "Read only: contributing shares[].id receipts from list; never permission grants.",
      },
      query: str,
      limit: { type: "integer", minimum: 1, maximum: 100 },
      cursor: {
        type: "object",
        properties: { until: { type: "integer", minimum: 0 }, before_id: str },
        required: ["until", "before_id"],
        additionalProperties: false,
      },
    },
  ),
  tool("channels", "Channels you are in; with all, every one you can see.", {
    q: str,
    all: { type: "boolean" },
  }),
  tool(
    "channel",
    "Channel details (default: current), or an action on it. create may use your owner's template, by name. delete is permanent.",
    {
      channel: str,
      action: {
        type: "string",
        enum: [
          "create",
          "update",
          "join",
          "leave",
          "archive",
          "unarchive",
          "delete",
        ],
      },
      name: str,
      about: str,
      visibility: { type: "string", enum: ["open", "private"] },
      type: { type: "string", enum: ["stream", "forum"] },
      ttl: {
        type: "integer",
        description: "Seconds without a message before it archives; 0: never.",
      },
      topic: str,
      purpose: str,
      template: str,
    },
  ),
  tool(
    "members",
    "A channel's members; add or remove pubkeys or npubs, giving those added a role.",
    {
      channel: str,
      add: strs,
      remove: strs,
      role: { type: "string", enum: ROLES },
    },
  ),
  tool("users", "Profiles by pubkey or name.", { ids: strs, q: str }),
  tool("dm", "Open a DM; returns its channel.", { to: strs }, ["to"]),
  tool("mem_get", "Read memory; without slug, list slugs.", { slug: str }),
  tool("mem_set", "Write memory.", { slug: str, text: str, path: str }, [
    "slug",
  ]),
  tool("canvas", "Read a channel's canvas, or replace it.", {
    channel: str,
    text: str,
    path: str,
  }),
  tool(
    "media_get",
    "Get a file of any type from a Buzz media URL: saves it locally and gives its path; an image is also shown.",
    { url: str },
    ["url"],
  ),
  tool(
    "tabs",
    "Your owner's open tabs for this channel's threads, or open, close or rename a thread's tab. Opening never takes their focus; no name clears a rename.",
    {
      action: { type: "string", enum: ["open", "close", "rename"] },
      thread: str,
      name: str,
    },
  ),
];

/** Message kinds as the CLI reads them. */
const MESSAGES = [9, 40002, 40008, 45001, 45003];
const THREAD = [9, 40002, 40008, 45003];
const SEARCH = [9, 40002, 45001, 45003];
const HEX = /^[0-9a-f]{64}$/;
/** A read's page size and scan budget. */
const PAGE = 500;
const MAX_EVENTS = 10_000;
const CHANNEL_BYTES = 16_384;
const CHANNEL_PARTIAL =
  "Partial channel list: scan or output limit reached. Narrow with q or use a known channel ID.";
/** The `channel` arguments each action takes. */
const ACTIONS: Readonly<Record<string, readonly string[]>> = {
  details: [],
  create: ["name", "about", "visibility", "type", "ttl", "template"],
  update: ["name", "about", "visibility", "ttl", "topic", "purpose"],
  join: [],
  leave: [],
  archive: [],
  unarchive: [],
  delete: [],
};

type Args = Readonly<Record<string, unknown>>;
/** A tool's answer: text, or an image (base64 `data`) for the agent to see,
 * with any `text` about it. */
export type Reply =
  | string
  | Readonly<{ data: string; type: string; text?: string }>;
type Handler = (tools: Tools, args: Args) => Promise<Reply>;

/** Runs tool `name` for an agent working in `context`. A throw is a tool
 * error for the agent to correct. */
export function callTool(
  client: BuzzClient,
  context: Context,
  name: string,
  args: Args,
) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`No tool ${name}`);
  return handler(new Tools(client, context), args);
}

const HANDLERS: Readonly<Record<string, Handler>> = {
  async shared_sessions({ client, context }, args) {
    if (!context.channel) throw new Error("A current channel is required.");
    const allowed = new Set([
      "action",
      "source",
      "share_ids",
      "query",
      "limit",
      "cursor",
    ]);
    if (Object.keys(args).some((key) => !allowed.has(key)))
      throw new Error(
        "Unknown shared_sessions argument; the audience is the current channel.",
      );
    const action = args.action ?? "list";
    if (action !== "list" && action !== "read")
      throw new Error("action must be list or read.");
    const limit = args.limit;
    if (
      limit !== undefined &&
      (typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100)
    )
      throw new Error("limit must be an integer from 1 to 100.");
    let cursor: { until: number; before_id: string } | undefined;
    if (args.cursor !== undefined) {
      const value = args.cursor as Record<string, unknown> | null;
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some(
          (key) => key !== "until" && key !== "before_id",
        ) ||
        typeof value.until !== "number" ||
        !Number.isSafeInteger(value.until) ||
        value.until < 0 ||
        typeof value.before_id !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.before_id)
      )
        throw new Error(
          "cursor must contain until and a 64-character event before_id.",
        );
      cursor = { until: value.until, before_id: value.before_id };
    }
    if (action === "read") {
      if (typeof args.source !== "string" || !args.source.trim())
        throw new Error("source is required for read.");
      if (args.query !== undefined)
        throw new Error("query is only supported by list.");
      const shareIds = args.share_ids;
      if (
        shareIds !== undefined &&
        (!Array.isArray(shareIds) ||
          shareIds.length < 1 ||
          shareIds.length > 32 ||
          shareIds.some(
            (id) => typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id),
          ) ||
          new Set(shareIds).size !== shareIds.length)
      )
        throw new Error(
          "share_ids must contain 1 to 32 unique lowercase 64-character event IDs.",
        );
      return JSON.stringify(
        await readSharedSession(client, context.channel, args.source, {
          ...(shareIds !== undefined ? { shareIds } : {}),
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      );
    }
    if (args.source !== undefined || args.share_ids !== undefined)
      throw new Error("source and share_ids are only supported by read.");
    if (args.query !== undefined && typeof args.query !== "string")
      throw new Error("query must be text.");
    return JSON.stringify(
      await listSharedSessions(client, context.channel, {
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(args.query !== undefined ? { query: args.query } : {}),
        audience: context.channel,
      }),
    );
  },
  async send(tools, args) {
    const { client, context } = tools;
    const reply =
      text(args.reply) ??
      (args.channel === undefined ? context.root : undefined);
    // A reply goes to its message's channel.
    const channel =
      text(args.channel) ??
      (reply && reply !== context.root
        ? tag(await tools.event(reply), "h")
        : undefined) ??
      context.channel;
    if (!channel) throw new Error("channel is required here.");
    if (reply && context.topLevel && channel === context.channel)
      throw new Error(
        "This chat stays at the top level: send again without reply.",
      );
    if (args.audience !== "everyone" && args.audience !== "agents")
      throw new Error("audience must be everyone or agents.");
    const ui = args.ui === undefined ? undefined : readInlineUi(args.ui);
    if (ui && "error" in ui) throw new Error(ui.error);
    if (ui && list(args.files).length)
      throw new Error("Send files in their own message, not with ui.");
    const files = await tools.attach(list(args.files));
    const body = (await tools.body(args, !files.links || !!ui)) ?? "";
    if (ui && !body.trim()) throw new Error("ui needs text: the question.");
    const content = ui ? inlineUiContent(body, ui.ui) : `${body}${files.links}`;
    const thread = reply ? await tools.threadTags(reply) : [];
    const mentions = await tools.mentions(
      channel,
      content,
      list(args.mentions),
    );
    const event = await client.publish({
      kind: 9,
      content,
      tags: [
        ["h", channel],
        ...thread,
        ...mentions.map((pubkey) => ["p", pubkey]),
        ...files.tags,
        ...(args.audience === "agents" ? [["audience", "agents"]] : []),
        ...(ui ? [[UI_TAG, JSON.stringify(ui.ui)]] : []),
      ],
    });
    return `sent ${event.id}`;
  },

  async edit(tools, args) {
    const id = required(args, "id");
    const target = await tools.event(id);
    const channel = tag(target, "h");
    if (!channel) throw new Error(`${id} is not a channel message.`);
    await tools.client.publish({
      kind: 40003,
      content: required(args, "text"),
      // An edit replaces the attachments too, so it keeps the message's.
      tags: [
        ["h", channel],
        ["e", id],
        ...target.tags.filter((t) => t[0] === "imeta"),
      ],
    });
    return "edited";
  },

  async react(tools, args) {
    const { client } = tools;
    const id = required(args, "id");
    const emoji = required(args, "emoji");
    if (args.off !== true) {
      await client.publish({ kind: 7, content: emoji, tags: [["e", id]] });
      return "reacted";
    }
    const mine = await client.query([
      { kinds: [7], "#e": [id], authors: [client.pubkey], limit: 100 },
    ]);
    const reaction = mine.find((event) => event.content === emoji);
    if (!reaction) return "no such reaction";
    await client.publish({ kind: 5, content: "", tags: [["e", reaction.id]] });
    return "removed";
  },

  async read(tools, args) {
    const { client, context } = tools;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const before = unixTime(args, "before");
    const since = unixTime(args, "since");
    if (since !== undefined && before !== undefined && since > before)
      throw new Error("since must not be after before.");
    let author: string | undefined;
    if (args.author !== undefined)
      try {
        author = pubkey(args.author as string);
      } catch {
        throw new Error(
          "author must be a hex pubkey or npub; users finds one by name.",
        );
      }
    const beforeId = args.before_id;
    if (beforeId !== undefined && before === undefined)
      throw new Error("before_id needs before, from the same continue line.");
    if (
      beforeId !== undefined &&
      (typeof beforeId !== "string" || !HEX.test(beforeId))
    )
      throw new Error("before_id must be a 64-character event ID.");
    const filters = {
      ...(author ? { authors: [author] } : {}),
      ...(since !== undefined ? { since } : {}),
    };
    // The relay's cursor: at or before `until`, after `before_id` at a tie.
    const cursor = {
      ...(before !== undefined ? { until: before } : {}),
      ...(beforeId ? { before_id: beforeId } : {}),
    };
    const q = text(args.q);
    let channel = text(args.channel) ?? context.channel;
    if (q) {
      if (beforeId)
        throw new Error(
          "before_id pages thread and channel reads; narrow a search with before or since.",
        );
      const max = bound(limit, 20, 100);
      const found = await client.query([
        {
          kinds: SEARCH,
          search: q,
          limit: max,
          ...(args.channel ? { "#h": [channel] } : {}),
          ...cursor,
          ...filters,
        },
      ]);
      const lines = await tools.messages(found, {});
      if (!lines.length) return "No messages.";
      if (found.length >= max)
        lines.push(
          "Result limit reached; more matches may exist. Narrow with channel, author, since or before.",
        );
      return lines.join("\n");
    }
    let scope: { channel?: string; root?: string };
    let max: number;
    let more: Args;
    let found: readonly BuzzEvent[];
    let first: BuzzEvent | undefined;
    if (text(args.thread) || (args.channel === undefined && context.root)) {
      if (author || since !== undefined)
        throw new Error(
          "author and since filter a search (q) or a channel read, not a thread; add q or channel.",
        );
      const id = text(args.thread) ?? (context.root as string);
      let root = id;
      if (id !== context.root) {
        const event = await tools.event(id);
        root = rootOf(event);
        channel = tag(event, "h") ?? channel;
      }
      if (!channel) throw new Error("channel is required here.");
      max = bound(limit, 100, 500);
      // The root comes on the first page only, apart from the replies' limit
      // and cursor.
      const events = await client.query([
        {
          kinds: THREAD,
          "#h": [channel],
          "#e": [root],
          limit: max + 1,
          ...cursor,
        },
        ...(before === undefined
          ? [{ ids: [root], kinds: [...THREAD, 45001], limit: 1 }]
          : []),
      ]);
      first = events.find((event) => event.id === root);
      found = events.filter((event) => event.id !== root);
      scope = { channel, root };
      more = { thread: root, limit: max };
    } else {
      if (!channel) throw new Error("channel is required here.");
      max = bound(limit, 30, 200);
      found = await client.query([
        {
          kinds: MESSAGES,
          "#h": [channel],
          limit: max + 1,
          ...cursor,
          ...filters,
        },
      ]);
      scope = { channel };
      more = {
        channel,
        ...(author ? { author } : {}),
        ...(since !== undefined ? { since } : {}),
        limit: max,
      };
    }
    // One more than the limit tells whether older messages remain; the last
    // shown, in the relay's newest-first order, is where the next page starts.
    // A short page is only what the relay returned: serving-time filtering and
    // retention can leave older history unseen.
    const shown = found.slice(0, max);
    const last = shown.at(-1);
    const lines = await tools.messages(
      first ? [first, ...shown] : shown,
      scope,
    );
    if (!lines.length) return "No messages.";
    const noun = scope.root ? "replies" : "messages";
    return [
      scope.root ? `thread ${scope.root} in ${channel}` : `channel ${channel}`,
      ...lines,
      last && found.length > max
        ? `Older ${noun} remain; continue with ${JSON.stringify({ ...more, before: last.created_at, before_id: last.id })}`
        : `The relay returned no older ${noun}.`,
    ].join("\n");
  },

  async channels(tools, args) {
    const { client } = tools;
    const ids = new Set<string>();
    const membershipsComplete = await tools.scan(
      { kinds: [39002], "#p": [client.pubkey] },
      (event) => {
        const id = tag(event, "d");
        if (id) ids.add(id);
        return true;
      },
    );
    const all = args.all === true;
    const q = text(args.q)?.toLowerCase();
    const rows: string[] = [];
    const encoder = new TextEncoder();
    // Reserve the partial-result notice even when the last row fills the budget.
    let bytes = encoder.encode(CHANNEL_PARTIAL).length;
    const channelsComplete =
      !ids.size && !all
        ? true
        : await tools.scan(
            all ? { kinds: [39000] } : { kinds: [39000], "#d": [...ids] },
            (event) => {
              const id = tag(event, "d") ?? "";
              const flags = [
                tag(event, "t") === "stream" ? "" : tag(event, "t"),
                has(event, "private") ? "private" : "",
                has(event, "archived") ? "archived" : "",
                ids.has(id)
                  ? ""
                  : membershipsComplete
                    ? "not joined"
                    : "membership unknown",
              ].filter(Boolean);
              const row = `${id} ${tag(event, "name") ?? ""}${flags.length ? ` (${flags.join(", ")})` : ""}`;
              if (q && !row.toLowerCase().includes(q)) return true;
              if (rows.length === PAGE) return false;
              const size = encoder.encode(row).length + 1;
              if (bytes + size > CHANNEL_BYTES) {
                // Preserve a usable ID when one channel has oversized details.
                const brief = `${id} (details omitted; use channel for details)`;
                if (bytes + encoder.encode(brief).length + 1 <= CHANNEL_BYTES)
                  rows.push(brief);
                return false;
              }
              rows.push(row);
              bytes += size;
              return true;
            },
          );
    if (!membershipsComplete || !channelsComplete) rows.push(CHANNEL_PARTIAL);
    return rows.join("\n") || "No channels.";
  },

  async channel(tools, args) {
    const { client } = tools;
    const action = args.action ?? "details";
    const fields =
      typeof action === "string" && Object.hasOwn(ACTIONS, action)
        ? ACTIONS[action]
        : undefined;
    if (typeof action !== "string" || !fields)
      throw new Error(
        `action must be one of ${Object.keys(ACTIONS).join(", ")}.`,
      );
    const extra = Object.keys(args).filter(
      (key) => key !== "channel" && key !== "action" && !fields.includes(key),
    );
    if (extra.length)
      throw new Error(`${extra.join(", ")} cannot be used with ${action}.`);
    if (action === "create") {
      if (args.channel !== undefined)
        throw new Error("create makes a new channel; leave out channel.");
      return tools.create(args);
    }
    const channel = target(tools, args);
    if (action === "details") return tools.details(channel);
    if (action === "update") return tools.update(channel, args);
    const { kind, content, tags } = lifecycleTemplate(
      action as "join" | "leave" | "archive" | "unarchive" | "delete",
      channel,
    );
    await client.publish({ kind, content, tags });
    // The relay can accept a change it then fails to make, so it is reported
    // only once the channel shows it.
    const shown = async () => {
      if (action === "join" || action === "leave")
        return (
          (await tools.roster(channel)).some(
            (member) => member.pubkey === client.pubkey,
          ) ===
          (action === "join")
        );
      const metadata = await tools.metadata(channel);
      if (action === "delete") return !metadata;
      return !!metadata && has(metadata, "archived") === (action === "archive");
    };
    const done: Readonly<Record<string, string>> = {
      join: "joined",
      leave: "left",
      archive: "archived",
      unarchive: "unarchived",
      delete: "deleted",
    };
    const now = await until(shown, Boolean).catch(unread);
    if (now === true) return `${done[action]} ${channel}`;
    return `The community accepted ${action} but ${now ? now.message : "does not show it yet"}.`;
  },

  async members(tools, args) {
    const channel = target(tools, args);
    const add = keys(args, "add");
    const remove = keys(args, "remove");
    const role = args.role;
    if (role !== undefined && !ROLES.includes(role as string))
      throw new Error(`role must be one of ${ROLES.join(", ")}.`);
    if (role !== undefined && !add.length)
      throw new Error("role is for the members you add.");
    if (add.length || remove.length) {
      lifecycleChannelId(channel);
      if ([...add, ...remove].includes(tools.client.pubkey))
        throw new Error("For yourself, use channel with action join or leave.");
      if (add.some((key) => remove.includes(key)))
        throw new Error("Add or remove someone, not both.");
      if (add.length + remove.length > 50)
        throw new Error("Change at most 50 members at a time.");
      const { lines, changed } = await tools.change(
        channel,
        add,
        remove,
        role as string | undefined,
      );
      if (!changed) throw new Error(lines.join("\n"));
      return lines.join("\n");
    }
    const members = await tools.members(channel);
    const names = await tools.names(members.map((member) => member.pubkey));
    return members
      .map(
        ({ pubkey, role }) =>
          `${pubkey} ${names.get(pubkey) ?? ""}${role === "member" ? "" : ` (${role})`}`,
      )
      .join("\n");
  },

  async users(tools, args) {
    const { client } = tools;
    const ids = list(args.ids).map(pubkey);
    const q = text(args.q)?.toLowerCase();
    if (!ids.length && !q) throw new Error("Give ids or q.");
    // Name search matches only name and display_name, best match first;
    // NIP-50 search matches the whole profile, so text in avatars or `about`
    // can fill its results and hide the person asked for. Name search refuses
    // a query longer than its limit, so a longer name uses NIP-50 search.
    const named =
      !ids.length && q && [...q].length <= PROFILE_SEARCH_QUERY_MAX
        ? await client.searchProfiles?.(q, PROFILE_SEARCH_MAX)
        : undefined;
    const profiles =
      named?.filter((event) => event.kind === 0) ??
      (await client.query([
        ids.length
          ? { kinds: [0], authors: ids, limit: ids.length }
          : { kinds: [0], search: q, limit: 100 },
      ]));
    const rows = newest(profiles)
      .map((event) => {
        const profile = parse(event.content);
        const name = profileName(profile) ?? "";
        const about =
          typeof profile.about === "string" && profile.about.trim()
            ? ` — ${profile.about.trim().slice(0, 120)}`
            : "";
        return { name, row: `${event.pubkey} ${name}${about}` };
      })
      .filter(
        ({ name }) =>
          !q || ids.length || named || name.toLowerCase().includes(q),
      );
    return rows.map(({ row }) => row).join("\n") || "No users.";
  },

  async dm(tools, args) {
    const { client } = tools;
    const to = list(args.to).map(pubkey);
    if (!to.length) throw new Error("to is required.");
    const people = new Set([client.pubkey, ...to]);
    const find = async () =>
      (
        await client.query([
          { kinds: [39000], "#p": [client.pubkey], "#t": ["dm"], limit: 500 },
        ])
      ).find((event) => {
        const members = new Set(
          event.tags.filter((t) => t[0] === "p").map((t) => t[1]),
        );
        return (
          members.size === people.size &&
          [...people].every((key) => members.has(key))
        );
      });
    let found = await find();
    if (!found) {
      await client.publish({
        kind: 41010,
        content: "",
        tags: [...to.map((key) => ["p", key]), ["d", crypto.randomUUID()]],
      });
      // The relay creates the channel's metadata just after answering.
      for (let tries = 0; !found && tries < 5; tries++) {
        if (tries) await new Promise((resolve) => setTimeout(resolve, 400));
        found = await find();
      }
    }
    const channel = found && tag(found, "d");
    if (!channel) throw new Error("The DM did not open.");
    return channel;
  },

  async mem_get(tools, args) {
    const slug = text(args.slug);
    if (!slug) {
      const { entries, partial } = await tools.client.memories();
      const lines = entries
        .map((entry) => `${entry.slug} ${time(entry.createdAt)}`)
        .join("\n");
      if (!partial) return lines || "No memory.";
      if (!lines) throw new Error("Memory could not be read; try again.");
      return `${lines}\nThis list is incomplete: some memory could not be read.`;
    }
    const key = memorySlug(slug);
    const { entries, partial } = await tools.client.memories(key);
    const body = entries.find((entry) => entry.slug === key)?.body;
    if (body !== undefined) return body;
    if (partial) throw new Error(`Memory ${key} could not be read; try again.`);
    return `No memory ${key}.`;
  },

  async mem_set(tools, args) {
    const key = memorySlug(required(args, "slug"));
    const body = (await tools.body(args, true)) as string;
    // A write must be dated after the entry it replaces, so it waits for a
    // read that finds the entry or confirms there is none.
    const { entries, partial } = await tools.client.memories(key);
    const current = entries.find((entry) => entry.slug === key);
    if (!current && partial)
      throw new Error(`Memory ${key} could not be read; try again.`);
    await tools.client.remember(key, body, current?.createdAt ?? 0);
    return "saved";
  },

  async canvas(tools, args) {
    const { client, context } = tools;
    const channel = text(args.channel) ?? context.channel;
    if (!channel) throw new Error("channel is required here.");
    const content = await tools.body(args, false);
    const [head] = await client.query([
      { kinds: [40100], "#h": [channel], limit: 1 },
    ]);
    if (!head && !(await tools.metadata(channel))) throw unseen(channel);
    if (content === undefined) return head?.content || "No canvas.";
    // The newest canvas wins, so a write must be dated after the current one.
    const wait = head ? (head.created_at + 1) * 1000 - Date.now() : 0;
    if (wait > 5000) throw new Error("The canvas was just changed; try again.");
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    await client.publish({ kind: 40100, content, tags: [["h", channel]] });
    return "saved";
  },

  async media_get(tools, args) {
    const media = await tools.client.media(required(args, "url"));
    const saved = `Saved ${media.path} (${media.type}, ${media.size} bytes).`;
    if (media.data) {
      // The first 12 bytes name the type.
      const head = atob(media.data.slice(0, 16));
      const type = sniff(Uint8Array.from(head, (c) => c.charCodeAt(0)));
      if (type?.startsWith("image/"))
        return { data: media.data, type, text: saved };
    }
    return `${saved} Open it with your own tools.`;
  },

  async tabs(tools, args) {
    const { client, context } = tools;
    const tabs = client.tabs;
    if (!tabs)
      throw new Error(
        "Tabs are kept in Buzz Desktop and are unavailable here.",
      );
    // Only the channel the agent works in, so it never pulls the owner
    // toward another conversation.
    const channel = context.channel;
    if (!channel) throw new Error("Tabs need a channel to work in.");
    if (args.action === undefined) {
      const open = tabs.list(channel);
      return open.length
        ? open
            .map(
              (tab) =>
                `${tab.root} ${tab.pane}${tab.name ? ` ${JSON.stringify(tab.name)}` : ""}${tab.shown ? " (shown)" : ""}`,
            )
            .join("\n")
        : "No thread tabs open.";
    }
    if (
      args.action !== "open" &&
      args.action !== "close" &&
      args.action !== "rename"
    )
      throw new Error("action must be open, close or rename.");
    const event = await tools.event(required(args, "thread"));
    if (tag(event, "h") !== channel)
      throw new Error(`${event.id} is not in this channel.`);
    // Resolve the root as the reader does, so the tab matched is the one shown.
    const root = threadReference(event)?.rootId ?? event.id;
    if (args.action === "open")
      return tabs.open(channel, root) ? `opened ${root}` : "already open";
    if (args.action === "rename")
      return tabs.rename(channel, root, optional(args, "name") ?? "")
        ? "renamed"
        : "not open";
    const closed = tabs.close(channel, root);
    if (closed === "shown")
      throw new Error("Your owner is looking at that tab, so it stays open.");
    return closed === "closed" ? "closed" : "not open";
  },
};

/** One call's helpers, so lookups it repeats are made once. */
class Tools {
  private readonly cache = new Map<string, Promise<unknown>>();
  constructor(
    readonly client: BuzzClient,
    readonly context: Context,
  ) {}

  private once<T>(key: string, load: () => Promise<T>) {
    let value = this.cache.get(key) as Promise<T> | undefined;
    if (!value) {
      value = load();
      this.cache.set(key, value);
    }
    return value;
  }

  /** `text`, or the file at `path`. Undefined when neither is given and
   * `needed` is false. */
  async body(args: Args, needed: boolean) {
    const path = text(args.path);
    const value = path
      ? new TextDecoder().decode(await this.client.read(path))
      : typeof args.text === "string"
        ? args.text
        : undefined;
    if (value === undefined && needed) throw new Error("Give text or path.");
    return value;
  }

  async event(id: string) {
    if (!HEX.test(id)) throw new Error(`Not an event id: ${id}`);
    const [event] = await this.client.query([
      { ids: [id], kinds: [...THREAD, 45001], limit: 1 },
    ]);
    if (!event) throw new Error(`No message ${id}.`);
    return event;
  }

  /** The e-tag of a reply to `parent`. Agents never nest: a reply to any
   * message in a thread is a reply to the thread's root. */
  async threadTags(parent: string) {
    const root =
      parent === this.context.root ? parent : rootOf(await this.event(parent));
    return [["e", root, "", "reply"]];
  }

  /** Visit matching events in relay order, retaining only what the caller needs.
   * False means the scan or caller's output budget stopped the listing. */
  async scan(filter: Filter, visit: (event: BuzzEvent) => boolean) {
    let count = 0;
    for (let cursor = {}; ; ) {
      const limit = Math.min(PAGE, MAX_EVENTS - count + 1);
      const page = await this.client.query([{ ...filter, ...cursor, limit }]);
      for (const event of page) {
        if (++count > MAX_EVENTS || !visit(event)) return false;
      }
      const last = page.at(-1);
      if (!last || page.length < limit) return true;
      // The relay reads newest first, then by id.
      cursor = { until: last.created_at, before_id: last.id };
    }
  }

  members(channel: string) {
    return this.once(`members/${channel}`, () => this.roster(channel));
  }

  /** The channel's members now, uncached. */
  async roster(channel: string) {
    const [list] = await this.client.query([
      { kinds: [39002], "#d": [channel], limit: 1 },
    ]);
    return (list?.tags ?? [])
      .filter((t) => t[0] === "p" && t[1])
      .map((t) => ({ pubkey: t[1] as string, role: t[3] || "member" }));
  }

  /** The channel's metadata now, if the agent can see it. */
  async metadata(channel: string) {
    const [metadata] = await this.client.query([
      { kinds: [39000], "#d": [channel], limit: 1 },
    ]);
    return metadata;
  }

  async details(channel: string) {
    const metadata = await this.metadata(channel);
    if (!metadata) throw unseen(channel);
    const role = (await this.roster(channel)).find(
      (member) => member.pubkey === this.client.pubkey,
    )?.role;
    const flags = [
      tag(metadata, "t"),
      has(metadata, "private") ? "private" : "open",
      has(metadata, "archived") ? "archived" : "",
      tag(metadata, "ttl")
        ? `archives after ${tag(metadata, "ttl")}s idle`
        : "",
    ].filter(Boolean);
    return [
      `${channel} ${tag(metadata, "name") ?? ""} (${flags.join(", ")})`,
      ...(["about", "topic", "purpose"] as const).flatMap((key) =>
        tag(metadata, key) ? [`${key}: ${tag(metadata, key)}`] : [],
      ),
      `you: ${role ?? "not a member"}`,
    ].join("\n");
  }

  async create(args: Args) {
    const name = canonicalDetailsName(required(args, "name"));
    const about = optional(args, "about") || undefined;
    const ttl = seconds(args.ttl);
    checkDetails(name, about, ttl);
    if (args.visibility !== "open" && args.visibility !== "private")
      throw new Error("visibility must be open or private.");
    const type = args.type ?? "stream";
    if (type !== "stream" && type !== "forum")
      throw new Error("type must be stream or forum.");
    // Found first, so a wrong name creates nothing.
    const template =
      args.template === undefined
        ? undefined
        : await this.template(required(args, "template"));
    const id = crypto.randomUUID();
    await this.client.publish({
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", name],
        ["visibility", args.visibility],
        ["channel_type", type],
        ...(about ? [["about", about]] : []),
        ...(ttl ? [["ttl", String(ttl)]] : []),
      ],
    });
    const shown = await until(() => this.metadata(id), Boolean).catch(unread);
    if (!shown || shown instanceof Error)
      return `The community accepted channel ${id} but ${shown ? shown.message : "does not show it yet"}${template ? "; the template was not applied" : ""}.`;
    const lines = [`created ${id}`];
    if (!template) return lines.join("\n");
    // The template's own agents, as Buzz adds them; each is tried.
    const agents = template.agents.filter((key) => key !== this.client.pubkey);
    if (template.canvas.trim())
      try {
        await this.client.publish({
          kind: 40100,
          content: template.canvas,
          tags: [
            ["h", id],
            ["expected-revision", "none"],
          ],
        });
        lines.push("started the Canvas");
      } catch (error) {
        // As in Buzz, agents join only once the template's Canvas is started.
        lines.push(
          `Canvas not started${agents.length ? ", so no agents were added" : ""}: ${reason(error)}`,
        );
        return lines.join("\n");
      }
    if (agents.length) lines.push(...(await this.change(id, agents, [])).lines);
    return lines.join("\n");
  }

  /** The owner's template named `name`, as one, without guessing. */
  async template(name: string) {
    if (!this.client.templates)
      throw new Error(
        "Channel templates are kept in Buzz Desktop and are unavailable here.",
      );
    const templates = await this.client.templates();
    const found = templates.filter(
      (template) => template.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (found.length > 1)
      throw new Error(
        `${found.length} templates are named ${name}; your owner should rename one.`,
      );
    if (!found[0])
      throw new Error(
        `No template named ${name}. ${templates.length ? `Templates: ${templates.map((t) => t.name).join(", ")}.` : "Your owner has none."}`,
      );
    return found[0];
  }

  async update(channel: string, args: Args) {
    const metadata = await this.metadata(channel);
    if (!metadata) throw unseen(channel);
    const wanted: [string, string][] = [];
    if (args.name !== undefined)
      wanted.push(["name", canonicalDetailsName(required(args, "name"))]);
    for (const key of ["about", "topic", "purpose"]) {
      const value = optional(args, key);
      if (value !== undefined) wanted.push([key, value]);
    }
    if (args.visibility !== undefined) {
      if (args.visibility !== "open" && args.visibility !== "private")
        throw new Error("visibility must be open or private.");
      wanted.push(["visibility", args.visibility]);
    }
    if (args.ttl !== undefined)
      wanted.push(["ttl", String(seconds(args.ttl) ?? "")]);
    if (!wanted.length)
      throw new Error("Give name, about, visibility, ttl, topic or purpose.");
    const value = (key: string) => wanted.find((t) => t[0] === key)?.[1];
    checkDetails(
      value("name"),
      value("about"),
      Number(value("ttl")) || undefined,
    );
    await this.client.publish({
      kind: 9002,
      content: "",
      tags: [["h", lifecycleChannelId(channel)], ...wanted],
    });
    const shows = (now: BuzzEvent | undefined) =>
      !!now &&
      wanted.every(([key, value]) =>
        key === "visibility"
          ? has(now, "private") === (value === "private")
          : (tag(now, key) ?? "") === value,
      );
    const now = await until(() => this.metadata(channel), shows).catch(unread);
    if (now instanceof Error)
      return `The community accepted the update but ${now.message}.`;
    return shows(now)
      ? `updated ${channel}`
      : "The community accepted the update but does not show it yet.";
  }

  /** Adds and removes members, each tried on its own, and reports each as the
   * roster shows it. `changed` is whether any was accepted. */
  async change(
    channel: string,
    add: readonly string[],
    remove: readonly string[],
    role?: string,
  ) {
    const refused = new Map<string, string>();
    for (const [targets, kind] of [
      [add, 9000],
      [remove, 9001],
    ] as const)
      for (const key of targets)
        try {
          await this.client.publish({
            kind,
            content: "",
            tags: [
              ["h", channel],
              ["p", key],
              ...(kind === 9000 && role ? [["role", role]] : []),
            ],
          });
        } catch (error) {
          refused.set(key, reason(error));
        }
    const added = (roster: Member[], key: string) =>
      roster.some((m) => m.pubkey === key && (!role || m.role === role));
    const removed = (roster: Member[], key: string) =>
      !roster.some((m) => m.pubkey === key);
    const roster = await until(
      () => this.roster(channel),
      (now) =>
        add.every((key) => refused.has(key) || added(now, key)) &&
        remove.every((key) => refused.has(key) || removed(now, key)),
    ).catch(unread);
    const names = await this.names([...add, ...remove]).catch(
      () => new Map<string, string>(),
    );
    const who = (key: string) =>
      names.has(key) ? `${key} ${names.get(key)}` : key;
    const report = (key: string, verb: string, done?: typeof added) =>
      refused.has(key)
        ? `not ${verb} ${who(key)}: ${refused.get(key)}`
        : roster instanceof Error
          ? `${who(key)}: the community accepted it but ${roster.message}`
          : done?.(roster, key)
            ? `${verb} ${who(key)}${verb === "added" && role ? ` as ${role}` : ""}`
            : `${who(key)}: the community accepted it but does not show it yet`;
    return {
      changed: refused.size < add.length + remove.length,
      lines: [
        ...add.map((key) => report(key, "added", added)),
        ...remove.map((key) => report(key, "removed", removed)),
      ],
    };
  }

  /** Display names of `pubkeys` that have a profile. */
  async names(pubkeys: readonly string[]) {
    const wanted = [...new Set(pubkeys)];
    const names = new Map<string, string>();
    if (!wanted.length) return names;
    const profiles = await this.client.query([
      { kinds: [0], authors: wanted, limit: wanted.length },
    ]);
    for (const event of newest(profiles)) {
      const name = profileName(parse(event.content));
      if (name) names.set(event.pubkey, name);
    }
    return names;
  }

  /** Messages oldest first with their latest edits, a line each: its ID,
   * author, channel and thread, leaving out those `scope` already names. */
  async messages(
    events: readonly BuzzEvent[],
    scope: Readonly<{ channel?: string; root?: string }>,
  ) {
    // An edit tags only the message it changes, so a thread's are not in it.
    const ids = events.filter((event) => event.kind !== 40003).map((e) => e.id);
    const edits = ids.length
      ? await this.client.query([{ kinds: [40003], "#e": ids, limit: 500 }])
      : [];
    const messages = edited([...events, ...edits]);
    const names = await this.names(messages.map((event) => event.pubkey));
    return messages.map((event) => {
      const name = names.get(event.pubkey);
      const channel = tag(event, "h");
      const thread = threadReference(event)?.rootId;
      return [
        event.id,
        `from ${event.pubkey}`,
        name && JSON.stringify(name),
        channel && channel !== scope.channel && `in ${channel}`,
        thread && thread !== scope.root && `re ${thread}`,
        `at ${time(event.created_at)}: ${event.content}`,
      ]
        .filter(Boolean)
        .join(" ");
    });
  }

  /** Who `content` notifies: `mentions`, `nostr:npub…` links, and `@Name`
   * for a channel member, as the CLI resolves them. Each must be a member. */
  async mentions(
    channel: string,
    content: string,
    explicit: readonly string[],
  ) {
    const keys = new Set(explicit.map(pubkey));
    for (const match of content.matchAll(/nostr:(npub1[02-9ac-hj-np-z]{58})/g))
      keys.add(pubkey(match[1] as string));
    const prose = content
      .replace(/^```[\s\S]*?^```/gm, " ")
      .replace(/`[^`\n]*`/g, " ");
    if (!prose.includes("@") && !keys.size) return [];
    const members = await this.members(channel);
    if (prose.includes("@")) {
      const byName = new Map<string, string[]>();
      for (const [key, name] of await this.names(
        members.map((member) => member.pubkey),
      )) {
        const lower = name.toLowerCase();
        byName.set(lower, [...(byName.get(lower) ?? []), key]);
      }
      const longest = [...byName.keys()].sort((a, b) => b.length - a.length);
      const unknown: string[] = [];
      for (const match of prose.matchAll(/(^|\s)@/g)) {
        const rest = prose
          .slice((match.index ?? 0) + match[0].length)
          .toLowerCase();
        const name = longest.find(
          (candidate) =>
            rest.startsWith(candidate) &&
            /^($|[\s,;.!?:)\]}])/.test(rest.slice(candidate.length)),
        );
        const found = name ? (byName.get(name) ?? []) : [];
        if (found.length === 1) keys.add(found[0] as string);
        else {
          const token = name ?? rest.match(/^[a-z0-9._-]+/)?.[0];
          if (token)
            unknown.push(`@${token}${found.length ? " (ambiguous)" : ""}`);
        }
      }
      if (unknown.length && !explicit.length)
        throw new Error(
          `No single channel member is ${unknown.join(", ")}. Pass their pubkeys in mentions, or drop the @.`,
        );
    }
    const outside = [...keys].filter(
      (key) => !members.some((member) => member.pubkey === key),
    );
    if (outside.length)
      throw new Error(`Not in this channel: ${outside.join(", ")}`);
    return [...keys].slice(0, 50);
  }

  /** Uploads each file and returns its `imeta` tags and the links to append.
   * Any file the community accepts attaches; it decides the type. */
  async attach(paths: readonly string[]) {
    const tags: string[][] = [];
    let links = "";
    for (const path of paths) {
      const data = await this.client.read(path);
      const upload = await this.client.upload(
        data,
        sniff(data) ?? "application/octet-stream",
      );
      const name = attachmentName(path.split(/[\\/]/).pop() ?? "");
      tags.push([...imeta(upload), `filename ${name}`]);
      links += `\n${attachmentMarkdown(name, upload)}`;
    }
    return { tags, links };
  }
}

/** The root of the thread `event` is in, by its NIP-10 markers. */
function rootOf(event: BuzzEvent) {
  const tags = event.tags.filter(
    (t) => t[0] === "e" && t.length >= 4 && HEX.test(t[1] ?? ""),
  );
  const root = tags.find((t) => t[3] === "root");
  const reply = tags.find((t) => t[3] === "reply");
  return ((root && reply ? root : reply)?.[1] ?? event.id) as string;
}

/** Messages oldest first, each showing its author's latest edit. */
function edited(events: readonly BuzzEvent[]) {
  const edits = new Map<string, BuzzEvent>();
  for (const event of events)
    if (event.kind === 40003) {
      const target = tag(event, "e");
      const last = target && edits.get(target);
      if (target && (!last || last.created_at < event.created_at))
        edits.set(target, event);
    }
  return events
    .filter((event) => event.kind !== 40003)
    .map((event) => {
      const edit = edits.get(event.id);
      return edit && edit.pubkey === event.pubkey
        ? { ...event, content: edit.content }
        : event;
    })
    .sort((a, b) => a.created_at - b.created_at);
}

/** Each author's newest event. */
function newest(events: readonly BuzzEvent[]) {
  const latest = new Map<string, BuzzEvent>();
  for (const event of events) {
    const seen = latest.get(event.pubkey);
    if (!seen || seen.created_at < event.created_at)
      latest.set(event.pubkey, event);
  }
  return [...latest.values()];
}

function imeta(upload: Upload) {
  return [
    "imeta",
    `url ${upload.url}`,
    `m ${upload.type}`,
    `x ${upload.sha256}`,
    `size ${upload.size}`,
    ...(["dim", "blurhash", "thumb", "duration"] as const)
      .filter((key) => upload[key] !== undefined)
      .map((key) => `${key} ${upload[key]}`),
  ];
}

/** An image or MP4's type, by the file's leading bytes. */
function sniff(data: Uint8Array) {
  const at = (offset: number, ...bytes: number[]) =>
    bytes.every((byte, index) => data[offset + index] === byte);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return "image/webp";
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return "video/mp4";
  return undefined;
}

function memorySlug(slug: string) {
  const key = slug === "core" || slug.startsWith("mem/") ? slug : `mem/${slug}`;
  if (
    key.length > 255 ||
    !/^(core|mem\/[a-z0-9][a-z0-9_-]{0,63}(\/[a-z0-9][a-z0-9_-]{0,63})*)$/.test(
      key,
    )
  )
    throw new Error(
      `Bad slug ${slug}: use lowercase parts like notes or team/plan.`,
    );
  return key;
}

function pubkey(value: string) {
  if (HEX.test(value.toLowerCase())) return value.toLowerCase();
  try {
    const decoded = decode(value);
    if (decoded.type === "npub") return decoded.data;
  } catch {}
  throw new Error(`Not a pubkey: ${value}`);
}

const profileName = (profile: Record<string, unknown>) =>
  [profile.display_name, profile.name].find(
    (name): name is string => typeof name === "string" && !!name.trim(),
  );
function parse(content: string): Record<string, unknown> {
  try {
    const value = JSON.parse(content);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
const tag = (event: BuzzEvent, name: string) =>
  event.tags.find((t) => t[0] === name)?.[1];
const has = (event: BuzzEvent, name: string) =>
  event.tags.some((t) => t[0] === name);
type Member = Readonly<{ pubkey: string; role: string }>;
const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Loads until `done` holds, a few times, and returns the last load: the
 * relay updates a channel's state just after answering. */
async function until<T>(load: () => Promise<T>, done: (value: T) => boolean) {
  let value = await load();
  for (let tries = 1; !done(value) && tries < 5; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    value = await load();
  }
  return value;
}

/** A channel without visible metadata, including a newly created channel. */
const unseen = (channel: string) =>
  new Error(
    `No channel ${channel} that you can see (it may not be visible yet). If you supplied a name, channels with q finds its ID.`,
  );

/** A failed read after a write, as the reason the write is not confirmed. */
const unread = (error: unknown) =>
  new Error(`its state could not be read back: ${reason(error)}`);

/** The `channel` argument, or the current channel only when it is left out. */
function target(tools: Tools, args: Args) {
  if (args.channel === undefined) {
    if (!tools.context.channel) throw new Error("channel is required here.");
    return tools.context.channel;
  }
  const channel = text(args.channel);
  if (!channel) throw new Error("channel must be a channel ID.");
  return channel;
}

/** A list of pubkeys or npubs, each once; any other entry is refused, not dropped. */
function keys(args: Args, name: string) {
  const value = args[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`${name} must be a list of pubkeys.`);
  return [...new Set(value.map(pubkey))];
}

/** An optional text argument, trimmed; refused when it is not text. */
function optional(args: Args, key: string) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be text.`);
  return value.trim();
}

/** A `ttl` argument: undefined when absent or 0, which means never. */
function seconds(value: unknown) {
  if (value === undefined || value === 0) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new Error("ttl must be a whole number of seconds.");
  return value;
}

/** A `since` or `before` argument: a Unix time in seconds, inclusive. */
function unixTime(args: Args, key: string) {
  const value = args[key];
  if (value === undefined) return undefined;
  // In milliseconds, a time from this century is past the year 5000.
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= 1e11
  )
    throw new Error(
      `${key} must be Unix seconds: a whole number, not milliseconds.`,
    );
  return value as number;
}

/** The checks Buzz makes on a channel's name, description and lifetime. */
function checkDetails(name?: string, about?: string, ttl?: number) {
  const errors = detailsDraftErrors({
    name: name ?? "-",
    description: about ?? "",
    visibility: "public",
    ttlSeconds: ttl,
  });
  const error = errors.name ?? errors.description ?? errors.lifetime;
  if (error) throw new Error(error);
}
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const list = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
function required(args: Args, name: string) {
  const value = args[name];
  if (typeof value !== "string" || !value)
    throw new Error(`${name} is required.`);
  return value;
}
const bound = (value: number | undefined, fallback: number, max: number) =>
  Math.max(1, Math.min(max, Math.floor(value ?? fallback)));
const time = (seconds: number) =>
  `${new Date(seconds * 1000).toISOString().slice(0, 16)}Z`;
