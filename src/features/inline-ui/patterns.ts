// Inline UI: the app-owned patterns an agent may attach to a message. The
// agent picks a pattern by name and supplies only its words; the app owns how
// it looks, which card is live and what a pick does. The message text always
// carries a plain-text version, so clients without the pattern still read it.

/** The signed tag holding a message's pattern as JSON. */
export const UI_TAG = "ui";

export const CHOICE_OPTIONS_MIN = 2;
export const CHOICE_OPTIONS_MAX = 6;
export const CHOICE_OPTION_MAX = 80;

/** Pick one of a few agent-written answers, or type your own. */
export type ChoiceUi = Readonly<{
  pattern: "choice";
  options: readonly string[];
}>;
export type InlineUi = ChoiceUi;

/** A pattern from untrusted input, or the reason it is not one, worded for
 * the agent that sent it. */
export function readInlineUi(
  value: unknown,
): Readonly<{ ui: InlineUi }> | Readonly<{ error: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { error: "ui must be an object." };
  const { pattern, options, ...rest } = value as Record<string, unknown>;
  if (pattern !== "choice") return { error: "ui.pattern must be choice." };
  if (Object.keys(rest).length)
    return { error: `ui has unknown fields: ${Object.keys(rest).join(", ")}.` };
  if (
    !Array.isArray(options) ||
    options.length < CHOICE_OPTIONS_MIN ||
    options.length > CHOICE_OPTIONS_MAX
  )
    return {
      error: `ui.options must list ${CHOICE_OPTIONS_MIN}–${CHOICE_OPTIONS_MAX} answers.`,
    };
  const labels: string[] = [];
  for (const option of options) {
    const label = typeof option === "string" ? option.trim() : "";
    if (!label || label.length > CHOICE_OPTION_MAX || /[\p{C}]/u.test(label))
      return {
        error: `Each ui option must be one line of 1–${CHOICE_OPTION_MAX} characters.`,
      };
    if (labels.some((seen) => seen.toLowerCase() === label.toLowerCase()))
      return { error: `ui options repeat “${label}”.` };
    labels.push(label);
  }
  return { ui: Object.freeze({ pattern, options: Object.freeze(labels) }) };
}

/** What a client without the pattern shows after the message text. */
export const fallbackText = (ui: InlineUi) =>
  `${ui.options.map((option, index) => `${index + 1}. ${option}`).join("\n")}\n\nOr reply with your own answer.`;

/** The message content for `text` with `ui` attached. */
export const inlineUiContent = (text: string, ui: InlineUi) =>
  `${text.trimEnd()}\n\n${fallbackText(ui)}`;

/** A received message's pattern and the text shown above it. Absent unless
 * the tag is valid and the content still ends with that pattern's plain-text
 * version, so an edited or hand-written message stays plain text. */
export function inlineUiMessage(
  content: string,
  tags: readonly (readonly string[])[],
): Readonly<{ ui: InlineUi; text: string }> | undefined {
  const raw = tags.find(([name]) => name === UI_TAG)?.[1];
  if (!raw || raw.length > 4096) return;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  const read = readInlineUi(value);
  if (!("ui" in read)) return;
  const suffix = `\n\n${fallbackText(read.ui)}`;
  if (!content.endsWith(suffix)) return;
  const text = content.slice(0, -suffix.length);
  return text.trim() ? Object.freeze({ ui: read.ui, text }) : undefined;
}
