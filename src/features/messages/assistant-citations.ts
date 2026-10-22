// Only complete provider envelopes on standalone prose lines are metadata.
const citationBlock =
  / {0,3}<oai-mem-citation>\s*<citation_entries>[^<>]*<\/citation_entries>\s*(?:<rollout_ids>[^<>]*<\/rollout_ids>\s*)?<\/oai-mem-citation>[ \t]*(?:\r?\n|$)/y;
const fencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/;

type Range = { start: number; end: number };

/** Display-only projection. The caller establishes assistant authorship. */
export function assistantDisplayContent(content: string): {
  content: string;
  removed: readonly Range[];
} {
  const removed: Range[] = [];
  if (!content.includes("<oai-mem-citation>")) return { content, removed };
  const output: string[] = [];
  let offset = 0;
  let fenceCharacter: string | undefined;
  let fenceLength = 0;
  let inlineLength = 0;
  while (offset < content.length) {
    const newline = content.indexOf("\n", offset);
    const end = newline < 0 ? content.length : newline + 1;
    const line = content.slice(offset, end);
    const fence = fencePattern.exec(line.trimEnd());
    if (fenceCharacter) {
      if (
        fence?.[1]?.[0] === fenceCharacter &&
        fence[1].length >= fenceLength &&
        !fence[2]?.trim()
      )
        fenceCharacter = undefined;
    } else if (!inlineLength && fence?.[1]) {
      fenceCharacter = fence[1][0];
      fenceLength = fence[1].length;
    } else {
      if (!inlineLength) {
        citationBlock.lastIndex = offset;
        const citation = citationBlock.exec(content);
        if (citation) {
          removed.push({ start: offset, end: citationBlock.lastIndex });
          offset = citationBlock.lastIndex;
          continue;
        }
      }
      // Preserve multiline and unfinished inline-code examples conservatively.
      for (const tick of line.matchAll(/`+/g)) {
        let slashes = 0;
        for (let i = tick.index - 1; i >= 0 && line[i] === "\\"; i--) slashes++;
        if (!inlineLength && slashes % 2) continue;
        const length = tick[0].length;
        if (!inlineLength) inlineLength = length;
        else if (inlineLength === length) inlineLength = 0;
      }
    }
    output.push(line);
    offset = end;
  }
  return { content: removed.length ? output.join("") : content, removed };
}

/** Keep attachment-removal boundaries aligned with the projected display body. */
export function citationDisplaySeams(
  seams: readonly number[],
  removed: readonly Range[],
): number[] {
  return seams.map((seam) => {
    let shift = 0;
    for (const range of removed) {
      if (range.start >= seam) break;
      shift += Math.min(seam, range.end) - range.start;
    }
    return seam - shift;
  });
}
