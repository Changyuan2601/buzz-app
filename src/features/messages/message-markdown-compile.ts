import type { Element, Root } from "hast";
import { urlAttributes } from "html-url-attributes";
import type { UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, unified } from "unified";
import type { AgentLibrary } from "../agents/library";
import { parseBuzzLink } from "../navigation/buzz-links";
import { profileKey } from "../profiles/target";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { emojiMatches, linkPart, messageParts } from "../relay/emoji";
import { safeLinkUrl, visibleHtmlSource } from "../relay/message-content";
import {
  isLiteralMarkdownContext,
  prepareMarkdown,
  type LiteralRange,
  type PreparedMarkdown,
} from "./markdown-preparation";
import { profileMentionParts } from "./profile-mentions";
import { remarkMessageGfm } from "./remark-message-gfm";
import { remarkSpoilers } from "./remark-spoilers";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  alt?: string;
  identifier?: string;
  label?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
  };
};

export type MarkdownSource = Pick<
  ChannelMessage,
  | "content"
  | "edited"
  | "attachmentSeams"
  | "mentions"
  | "mentionReferences"
  | "emoji"
>;
type InlinePart = {
  text: string;
  target?: string | undefined;
  literal?: boolean;
};
type ProtectedContent = {
  content: string;
  prefix: string;
  parts: InlinePart[];
};
/** Bind exact names on the FULL signed body, before Markdown decodes escapes or
 * divides emphasis. Reference labels must also survive unchanged for resolution. */
export function protectInlineContent(
  row: MarkdownSource,
  profiles: ReadonlyMap<string, Profile> | undefined,
  literalRanges: () => readonly LiteralRange[],
  agents: AgentLibrary["identities"],
  spoilerDelimiters: readonly number[],
): ProtectedContent {
  let rangeIndex = 0;
  const isLiteral = (start: number, end: number) => {
    const ranges = literalRanges();
    while (ranges[rangeIndex] && (ranges[rangeIndex]?.end ?? 0) <= start)
      rangeIndex++;
    return (ranges[rangeIndex]?.start ?? Infinity) < end;
  };

  // Numeric entities can manufacture private-use characters during parsing too.
  // Choose an unused prefix in that decoded source; never trust a fixed marker.
  const decoded = row.content.replace(
    /&#(x[a-f\d]{1,6}|\d{1,7});/gi,
    (entity, number: string) => {
      const code =
        number[0]?.toLowerCase() === "x"
          ? Number.parseInt(number.slice(1), 16)
          : Number.parseInt(number, 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    },
  );
  const used = new Set(
    [...decoded.matchAll(/[\uE000\uFFFC](\d+)\uE001/g)].map(
      (match) => match[1],
    ),
  );
  let nonce = 0;
  while (used.has(String(nonce))) nonce++;
  const prefix = `\uE000${nonce}\uE001`;
  const parts: InlinePart[] = [];
  const token = (part: InlinePart) => {
    parts.push(part);
    // Mention edges must keep their punctuation class for emphasis flanking:
    // @Honey* beside italic ! is punctuation on both sides, not a word. The
    // wire itself holds no emphasis there for a parser that does not split
    // out the mention first, since the name's star and the delimiter merge
    // into one run; the exact signed name was kept over italics that other
    // clients could read.
    // U+FFFC is a Unicode symbol, not Markdown syntax. Keep it inside the
    // nonce-protected token so restoration removes only generated characters.
    const start = part.target ? `\uFFFC${nonce}\uE001` : prefix;
    const end =
      part.target && /[\p{P}\p{S}]$/u.test(part.text) ? "\uFFFC" : "\uE002";
    return `${start}${parts.length - 1}${end}`;
  };
  let offset = 0;
  const content = profileMentionParts(row, profiles, agents)
    .map((segment) => {
      const start = offset;
      offset += segment.text.length;
      if (segment.target && !isLiteral(start, offset)) return token(segment);
      let partOffset = start;
      return messageParts(segment.text)
        .map((part) => {
          const partStart = partOffset;
          partOffset += part.length;
          const urlPart = linkPart(part);
          let result = "";
          let end = 0;
          // Protect explicitly encoded URL punctuation before GFM's fallback
          // autolinker decodes it. Restore as literal text, not another URL scan.
          const encoded = [...part.matchAll(/&#(58|46|64|x3a|x2e|x40);/gi)].map(
            (match) => ({
              start: match.index,
              end: match.index + match[0].length,
              literal: String.fromCodePoint(
                match[1]?.toLowerCase().startsWith("x")
                  ? Number.parseInt(match[1].slice(1), 16)
                  : Number(match[1]),
              ),
            }),
          );
          const replacements = [
            ...(urlPart
              ? []
              : Array.from(emojiMatches(part, row.emoji ?? []), (match) => ({
                  ...match,
                  literal: undefined,
                }))),
            ...(urlPart ? [] : encoded),
            ...spoilerDelimiters
              .filter(
                (start) =>
                  start >= partStart && start + 2 <= partStart + part.length,
              )
              .map((start) => ({
                start: start - partStart,
                end: start - partStart + 2,
                literal: undefined,
                spoiler: true,
              })),
          ].sort((a, b) => a.start - b.start);
          for (const match of replacements) {
            if (
              match.start < end ||
              isLiteral(partStart + match.start, partStart + match.end)
            )
              continue;
            result += part.slice(end, match.start);
            // Angle punctuation preserves the pipes' emphasis flanking while
            // `<` terminates GFM autolinks. The private-use first character is
            // not an HTML/autolink opener, so this remains a text delimiter.
            result +=
              "spoiler" in match
                ? `<${prefix}spoiler\uE002>`
                : token(
                    match.literal
                      ? { text: match.literal, literal: true }
                      : { text: part.slice(match.start, match.end) },
                  );
            end = match.end;
          }
          return result + part.slice(end);
        })
        .join("");
    })
    .join("");
  return { content, prefix, parts };
}

const placeholderPattern = (protectedContent: ProtectedContent) =>
  new RegExp(
    `[\uE000\uFFFC]${protectedContent.prefix.slice(1)}(\\d+)[\uE002\uFFFC]`,
    "g",
  );

export function inlineProtectionKey(
  row: MarkdownSource,
  profiles: ReadonlyMap<string, Profile> | undefined,
  agents: AgentLibrary["identities"],
) {
  const identities = [...row.mentions, ...(row.mentionReferences ?? [])];
  const mentions = identities.map((id) => [id, profiles?.get(id)?.name]);
  const mentioned = new Set(identities);
  const agentNames = agents
    .filter((agent) => mentioned.has(agent.pubkey))
    .map((agent) => [agent.pubkey, agent.name]);
  const emoji = row.emoji?.map(({ shortcode, url }) => [shortcode, url]);
  return JSON.stringify([
    row.edited === true,
    row.attachmentSeams,
    mentions,
    agentNames,
    emoji,
  ]);
}

/** Containers whose children are blocks. Raw HTML anywhere else is inline,
 * including plugin nodes such as `spoiler`, so it stays inline as text. */
const flowParents = new Set([
  "root",
  "blockquote",
  "listItem",
  "footnoteDefinition",
]);

/** Chat never renders raw HTML, but `<harness>` is still something the author
 * typed. Show the exact source as text, with chat line breaks, instead of
 * dropping it. Complete HTML comments stay hidden (`visibleHtmlSource`).
 * Run last: the source is literal, so no mention, emoji or autolink
 * processing applies. */
export function remarkLiteralHtml() {
  const literal = (value: string): MarkdownNode[] =>
    value
      .split(/\r?\n|\r/)
      .flatMap((line, index) => [
        ...(index ? [{ type: "break" }] : []),
        ...(line ? [{ type: "text", value: line }] : []),
      ]);
  return (tree: MarkdownNode) => {
    const visit = (parent: MarkdownNode) => {
      if (!parent.children) return;
      parent.children = parent.children.flatMap((child) => {
        if (child.type !== "html") {
          visit(child);
          return [child];
        }
        const source = visibleHtmlSource(child.value ?? "");
        if (!source.trim()) return [];
        const text = literal(source);
        return !flowParents.has(parent.type)
          ? text
          : [
              {
                type: "paragraph",
                children: text,
                ...(child.position ? { position: child.position } : {}),
              },
            ];
      });
    };
    visit(tree);
  };
}

/** Offer only Markdown prose to profile controls and inline plugins. */
export function remarkInlineContent(protectedContent: ProtectedContent) {
  const restore = (value: string) =>
    value.replace(
      placeholderPattern(protectedContent),
      (match, index: string) =>
        protectedContent.parts[Number(index)]?.text ?? match,
    );
  const restoreLiteral = (node: MarkdownNode) => {
    for (const key of [
      "value",
      "url",
      "title",
      "alt",
      "identifier",
      "label",
    ] as const) {
      const value = node[key];
      if (typeof value === "string") node[key] = restore(value);
    }
    for (const child of node.children ?? []) restoreLiteral(child);
  };
  return (tree: MarkdownNode) => {
    const visit = (parent: MarkdownNode) => {
      if (isLiteralMarkdownContext(parent.type)) {
        restoreLiteral(parent);
        return;
      }
      if (!parent.children) return;
      parent.children = parent.children.flatMap((child) => {
        if (child.type !== "text" || typeof child.value !== "string") {
          visit(child);
          return [child];
        }
        const parts: InlinePart[] = [];
        let plain = "";
        let end = 0;
        for (const match of child.value.matchAll(
          placeholderPattern(protectedContent),
        )) {
          plain += child.value.slice(end, match.index);
          const part = protectedContent.parts[Number(match[1])];
          if (part?.target || part?.literal) {
            if (plain) parts.push({ text: plain });
            parts.push(part);
            plain = "";
          } else {
            plain += part?.text ?? match[0];
          }
          end = match.index + match[0].length;
        }
        plain += child.value.slice(end);
        if (plain) parts.push({ text: plain });
        return parts.map((part) => ({
          type: "buzzInlineContent",
          data: {
            hName: "span",
            hProperties: {
              "data-inline-text": part.text,
              ...(part.literal ? { "data-literal-text": "true" } : {}),
              ...(part.target ? { "data-profile-target": part.target } : {}),
            },
          },
        }));
      });
    };
    visit(tree);
  };
}

export const transformUrl: UrlTransform = (value) =>
  parseBuzzLink(value) || profileKey(value) ? value : safeLinkUrl(value);

export const messageRemarkPlugins = (
  protectedContent: ProtectedContent,
): PluggableList => [
  remarkMessageGfm(protectedContent.content),
  remarkBreaks,
  [remarkSpoilers, `<${protectedContent.prefix}spoiler\uE002>`],
  [remarkInlineContent, protectedContent],
  remarkLiteralHtml,
];

/** The tree react-markdown would render with `skipHtml` and `transformUrl`:
 * the same unified pipeline, then its raw-node and URL pass. Pure data, so
 * every mount of the same body can share it. */
export function compileMessageMarkdown(
  protectedContent: ProtectedContent,
): Root {
  const processor = unified()
    .use(remarkParse)
    .use(messageRemarkPlugins(protectedContent))
    .use(remarkRehype, { allowDangerousHtml: true });
  const tree = processor.runSync(processor.parse(protectedContent.content));
  const clean = (parent: Root | Element) => {
    for (let index = 0; index < parent.children.length; ) {
      const node = parent.children[index];
      if (node?.type === "raw") {
        parent.children.splice(index, 1);
        continue;
      }
      if (node?.type === "element") {
        for (const [key, tags] of Object.entries(urlAttributes)) {
          if (
            Object.hasOwn(node.properties, key) &&
            (tags === null || tags.includes(node.tagName))
          )
            node.properties[key] = transformUrl(
              String(node.properties[key] || ""),
              key,
              node,
            );
        }
        clean(node);
      }
      index++;
    }
  };
  clean(tree);
  return tree;
}

/** Least-recently-used, bounded by entries and by source characters. */
function boundedCache<Value>(maxEntries: number, maxCharacters: number) {
  const entries = new Map<string, Value>();
  let characters = 0;
  const use = (key: string, create: () => Value): Value => {
    const cached = entries.get(key);
    if (cached !== undefined) {
      entries.delete(key);
      entries.set(key, cached);
      return cached;
    }
    const value = create();
    entries.set(key, value);
    characters += key.length;
    for (const [oldest] of entries) {
      if (entries.size <= maxEntries && characters <= maxCharacters) break;
      entries.delete(oldest);
      characters -= oldest.length;
    }
    return value;
  };
  return Object.assign(use, { has: (key: string) => entries.has(key) });
}

// Bodies are immutable for a given source and protection key, so remounts
// (virtualized rows, reopened threads, revisited channels) reuse the work.
export const preparedMarkdown = boundedCache<PreparedMarkdown>(
  2_000,
  4_000_000,
);
const compiledMarkdown = boundedCache<Root>(2_000, 4_000_000);

/** A row's compiled body. The key holds every row, profile and agent value
 * that protection reads, so equal keys compile to equal trees. */
export function messageMarkdownTree(
  sourceRow: MarkdownSource,
  prepared: Extract<PreparedMarkdown, { kind: "markdown" }>,
  profiles: ReadonlyMap<string, Profile> | undefined,
  agents: AgentLibrary["identities"],
  protectionKey = inlineProtectionKey(sourceRow, profiles, agents),
): Root {
  return compiledMarkdown(`${protectionKey}\u0000${sourceRow.content}`, () =>
    compileRowTree(sourceRow, prepared, profiles, agents),
  );
}

function compileRowTree(
  sourceRow: MarkdownSource,
  prepared: Extract<PreparedMarkdown, { kind: "markdown" }>,
  profiles: ReadonlyMap<string, Profile> | undefined,
  agents: AgentLibrary["identities"],
): Root {
  return compileMessageMarkdown(
    protectInlineContent(
      {
        content: prepared.content,
        // Seams index the folded body. Leave link-repaired prose unbound, as edits are.
        ...(sourceRow.edited ||
        (sourceRow.attachmentSeams && prepared.content !== sourceRow.content)
          ? { edited: true as const }
          : {}),
        ...(sourceRow.attachmentSeams
          ? { attachmentSeams: sourceRow.attachmentSeams }
          : {}),
        mentions: sourceRow.mentions,
        mentionReferences: sourceRow.mentionReferences ?? [],
        ...(sourceRow.emoji ? { emoji: sourceRow.emoji } : {}),
      },
      profiles,
      () => prepared.literalRanges,
      agents,
      prepared.spoilerDelimiters,
    ),
  );
}

/** A body to compile in the worker: the row's protection inputs as plain
 * data, keyed as `messageMarkdownTree` keys its cache. */
export type MarkdownCompileRequest = {
  key: string;
  row: MarkdownSource;
  profiles: [string, Profile][];
  agents: AgentLibrary["identities"];
};
export type MarkdownCompileResult = { key: string; tree: Root | undefined };

export function compileRequest({
  key,
  row,
  profiles,
  agents,
}: MarkdownCompileRequest): MarkdownCompileResult {
  const prepared = prepareMarkdown(row.content);
  return {
    key,
    tree:
      prepared.kind === "markdown"
        ? compileRowTree(row, prepared, new Map(profiles), agents)
        : undefined,
  };
}

function compileRequestFor(
  row: MarkdownSource,
  profiles: ReadonlyMap<string, Profile> | undefined,
  agents: AgentLibrary["identities"],
): MarkdownCompileRequest | undefined {
  const key = `${inlineProtectionKey(row, profiles, agents)}\u0000${row.content}`;
  if (compiledMarkdown.has(key)) return undefined;
  // Protection reads only the names of the row's own identities.
  const identities = new Set([
    ...row.mentions,
    ...(row.mentionReferences ?? []),
  ]);
  return {
    key,
    row: {
      content: row.content,
      mentions: row.mentions,
      ...(row.edited ? { edited: row.edited } : {}),
      ...(row.attachmentSeams ? { attachmentSeams: row.attachmentSeams } : {}),
      ...(row.mentionReferences
        ? { mentionReferences: row.mentionReferences }
        : {}),
      ...(row.emoji ? { emoji: row.emoji } : {}),
    },
    profiles: [...identities].flatMap((id) => {
      const profile = profiles?.get(id);
      return profile ? [[id, profile] as [string, Profile]] : [];
    }),
    agents: agents.filter((agent) => identities.has(agent.pubkey)),
  };
}

// undefined: not started; null: unavailable, so pages compile while idle.
let worker: Worker | null | undefined;
function compileWorker() {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === "undefined") return worker;
  try {
    worker = new Worker(
      new URL("./message-markdown.worker.ts", import.meta.url),
      { type: "module" },
    );
  } catch {
    return worker;
  }
  worker.onmessage = (event: MessageEvent<MarkdownCompileResult[]>) => {
    for (const { key, tree } of event.data)
      if (tree) compiledMarkdown(key, () => tree);
  };
  worker.onerror = () => {
    worker?.terminate();
    worker = null;
  };
  return worker;
}

// WebKit has no requestIdleCallback; there a short timer stands in.
type IdleHandle = number | ReturnType<typeof setTimeout>;
const requestIdle = (
  callback: (deadline?: IdleDeadline) => void,
): IdleHandle =>
  typeof requestIdleCallback === "function"
    ? requestIdleCallback(callback)
    : setTimeout(callback, 16);
const cancelIdle = (handle: IdleHandle) =>
  typeof handle === "number" && typeof cancelIdleCallback === "function"
    ? cancelIdleCallback(handle)
    : clearTimeout(handle);

/** Compiles bodies before they mount, in a worker or else while the page is
 * idle, so rows that scroll in render from the shared tree. Pages compile in
 * the order they are added, each newest first. A row that mounts first
 * compiles itself as before. */
export function createMarkdownPrecompiler(
  agents: () => AgentLibrary["identities"],
) {
  let pending: Array<{
    row: MarkdownSource;
    profiles: ReadonlyMap<string, Profile> | undefined;
  }> = [];
  let next = 0;
  let handle: IdleHandle | undefined;
  const compile = (deadline?: IdleDeadline) => {
    const end = performance.now() + (deadline?.timeRemaining() ?? 4);
    while (next < pending.length && performance.now() < end) {
      const item = pending[next++];
      if (!item) continue;
      const { row, profiles } = item;
      const prepared = preparedMarkdown(row.content, () =>
        prepareMarkdown(row.content),
      );
      if (prepared.kind === "markdown")
        messageMarkdownTree(row, prepared, profiles, agents());
    }
    if (next < pending.length) handle = requestIdle(compile);
    else {
      pending = [];
      next = 0;
      handle = undefined;
    }
  };
  return {
    add(
      rows: readonly MarkdownSource[],
      profiles: ReadonlyMap<string, Profile> | undefined,
    ) {
      const target = compileWorker();
      if (target) {
        const requests: MarkdownCompileRequest[] = [];
        for (let index = rows.length - 1; index >= 0; index--) {
          const row = rows[index];
          const request = row && compileRequestFor(row, profiles, agents());
          if (request) requests.push(request);
        }
        if (requests.length) target.postMessage(requests);
        return;
      }
      for (let index = rows.length - 1; index >= 0; index--) {
        const row = rows[index];
        if (row) pending.push({ row, profiles });
      }
      handle ??= requestIdle(compile);
    },
    cancel() {
      if (handle !== undefined) cancelIdle(handle);
      pending = [];
      next = 0;
      handle = undefined;
    },
  };
}
