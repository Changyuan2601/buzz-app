/** NIP-AP agent instructions versions (kind 44300): envelope rules shared by the
 * outbox, the native signer route and the session's deletion admission. The
 * native validator (`src-tauri/src/relay/instructions.rs`) mirrors them. */
export const INSTRUCTIONS_KIND = 44300;
export const INSTRUCTIONS_TEXT_MAX_BYTES = 131_072;
export const INSTRUCTIONS_CONTENT_MAX_BYTES = 218_548;
/** Content bound plus 2,048 B of envelope; the relay (#8202) admits it in one frame. */
export const INSTRUCTIONS_EVENT_MAX_BYTES =
  INSTRUCTIONS_CONTENT_MAX_BYTES + 2_048;

const hex = /^[0-9a-f]{64}$/;
type Tags = readonly (readonly string[])[];

/** The single lowercase-hex `p` a 44300 names, or undefined for a bad envelope. */
export function instructionsSubject(tags: Tags): string | undefined {
  const subjects = tags.filter(([name]) => name === "p");
  const [p] = subjects;
  if (
    subjects.length !== 1 ||
    p?.length !== 2 ||
    !hex.test(p[1] ?? "") ||
    tags.some(([name]) => name === "t" || name === "h")
  )
    return undefined;
  return p[1];
}

/** A kind 5 whose every `k` is exactly 44300 (at least one), with no `h`, and at
 * least one `e`. The targets it names, or undefined if it is any other kind 5. */
export function instructionsDeletionTargets(event: {
  kind: number;
  tags: Tags;
}): string[] | undefined {
  if (event.kind !== 5) return undefined;
  const kinds = event.tags.filter(([name]) => name === "k");
  const targets = event.tags
    .filter(([name]) => name === "e")
    .map(([, id]) => id ?? "");
  if (
    !kinds.length ||
    kinds.some(
      (tag) => tag.length !== 2 || tag[1] !== String(INSTRUCTIONS_KIND),
    ) ||
    event.tags.some(([name]) => name === "h") ||
    !targets.length ||
    targets.some((id) => !hex.test(id))
  )
    return undefined;
  return targets;
}

/** The relay's answers that do not prove a send was refused: an internal
 * `error:` and the clock-window refusal an in-window re-send can draw. */
export function uncertainRefusal(message: string): boolean {
  return message.startsWith("error:") || message.includes("timestamp too far");
}
