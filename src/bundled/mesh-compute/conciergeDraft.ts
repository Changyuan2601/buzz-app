export type Draft =
  | Readonly<{ action: "start" }>
  | Readonly<{ action: "rename"; name: string }>
  | Readonly<{
      action: "connect";
      instructions: string;
      test: string;
      harness: string;
    }>;

/** Model output proposes bounded steps; the owner chooses and applies actions. */
export function conciergeDraft(content: string): Draft | undefined {
  if (content.length > 12_000) return;
  const blocks = [
    ...content.matchAll(/^```buzz-agent\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm),
  ];
  if (blocks.length !== 1 || !blocks[0]?.[1]) return;
  try {
    const value = JSON.parse(blocks[0][1]);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const limits =
      value.action === "start"
        ? {}
        : value.action === "rename"
          ? { name: 60 }
          : value.action === "connect"
            ? { instructions: 4000, test: 400, harness: 200 }
            : undefined;
    if (
      !limits ||
      Object.keys(value).sort().join() !==
        ["action", ...Object.keys(limits)].sort().join()
    )
      return;
    for (const [key, limit] of Object.entries(limits)) {
      if (
        typeof value[key] !== "string" ||
        !value[key].trim() ||
        value[key].length > limit ||
        Array.from(value[key] as string).some(
          (character) =>
            character.charCodeAt(0) < 32 && !"\n\r\t".includes(character),
        )
      )
        return;
      value[key] = value[key].trim();
    }
    return value;
  } catch {
    return;
  }
}
