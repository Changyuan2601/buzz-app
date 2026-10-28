export type LocaleDefinition = {
  /** BCP 47 tag, also written to `lang` on translated regions. */
  tag: string;
  /** The language named in itself, so it stays recognizable in any UI language. */
  name: string;
};

export const sourceLocale = "en-US";

/** Shipped UI languages. Each also needs an entry in `lingui.config.ts`. */
export const locales = [
  { tag: sourceLocale, name: "English (United States)" },
  { tag: "pt-BR", name: "Português (Brasil)" },
  { tag: "zh-CN", name: "简体中文" },
] as const satisfies readonly LocaleDefinition[];

const language = (tag: string) => tag.split("-")[0];

/** Matches the exact tag, then the first supported locale sharing its language. */
export function matchLocale<T extends string>(
  value: unknown,
  supported: readonly T[],
): T | undefined {
  if (typeof value !== "string") return undefined;
  const tag = value.trim().replaceAll("_", "-").toLowerCase();
  if (!tag) return undefined;
  return (
    supported.find((candidate) => candidate.toLowerCase() === tag) ??
    supported.find(
      (candidate) => language(candidate.toLowerCase()) === language(tag),
    )
  );
}

/** The saved choice wins, then the system's preference order, then the source. */
export function resolveLocale<T extends string>(
  saved: unknown,
  preferred: readonly string[],
  supported: readonly T[],
  fallback: T,
): T {
  return (
    matchLocale(saved, supported) ??
    preferred
      .map((tag) => matchLocale(tag, supported))
      .find((tag) => tag !== undefined) ??
    fallback
  );
}
