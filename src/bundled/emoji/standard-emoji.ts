import { linkPart, messageParts } from "../../features/relay/emoji";

/** Shortcode (and alias) to native emoji, from the picker's Unicode dataset. */
export type StandardEmoji = ReadonlyMap<string, string>;

type Dataset = {
  emojis: Record<string, { skins: readonly { native?: string }[] }>;
  aliases: Record<string, string>;
};
export function standardEmoji(data: Dataset): StandardEmoji {
  const map = new Map<string, string>();
  for (const [id, emoji] of Object.entries(data.emojis)) {
    const native = emoji.skins[0]?.native;
    if (native) map.set(id, native);
  }
  for (const [alias, id] of Object.entries(data.aliases)) {
    const native = map.get(id);
    if (native && !map.has(alias)) map.set(alias, native);
  }
  return map;
}

let loading: Promise<StandardEmoji> | undefined;
/** Loads the dataset once, on first use: it stays out of startup. */
export function loadStandardEmoji(): Promise<StandardEmoji> {
  loading ??= import("@emoji-mart/data").then(
    (module) => standardEmoji(module.default as Dataset),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

const pattern = () => /:([a-z0-9_+-]{1,64}):/gi;
/** Whether text may hold a standard shortcode; cheap, before the dataset loads. */
export const mayHaveShortcode = (text: string) => pattern().test(text);

/** Ranges of known shortcodes such as `:+1:` or `:tada:`, never inside links. */
export function standardMatches(text: string, emoji: StandardEmoji) {
  const ranges: { start: number; end: number }[] = [];
  let offset = 0;
  for (const part of messageParts(text)) {
    if (!linkPart(part))
      for (const match of part.matchAll(pattern()))
        if (emoji.has((match[1] ?? "").toLowerCase()))
          ranges.push({
            start: offset + match.index,
            end: offset + match.index + match[0].length,
          });
    offset += part.length;
  }
  return ranges;
}
