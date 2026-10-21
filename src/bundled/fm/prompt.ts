// The words an fm turn sends Apple's on-device model. Its context holds about
// 8K tokens for the instructions, the prompt and the answer together, so a
// turn carries only the conversation's latest messages, newest kept first,
// and no Buzz tools.

/** Characters of earlier messages a prompt carries. Chat text runs about
 * four characters a token, IDs and code fewer, so this stays near 4K tokens
 * and leaves room for the instructions and a long answer. */
export const CONTEXT_CHARS = 12_000;
/** Characters kept of any one earlier message. */
export const MESSAGE_CHARS = 2_000;
/** Characters kept of the message the turn answers. */
export const LATEST_CHARS = 6_000;
/** Characters kept of it when even that alone does not fit: dense text such
 * as hashes or minified code runs near one character a token. */
export const SHORT_LATEST_CHARS = 1_500;
/** Characters kept of the owner's instructions. */
export const INSTRUCTIONS_CHARS = 2_000;

export type Line = Readonly<{ author: string; text: string }>;

const clip = (text: string, limit: number) => {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
};

/** The model's instructions: who it is, where it answers, what it can't do,
 * then the owner's own. */
export function instructions(
  input: Readonly<{ name: string; owner: string; instructions: string }>,
) {
  const own = clip(input.instructions, INSTRUCTIONS_CHARS);
  return [
    `You are ${input.name}, an AI agent in Buzz, a team chat app, working for ${input.owner}. You run entirely on this Mac with Apple's on-device Foundation Model, with no internet access.`,
    "Your reply is posted in this conversation, and you see only its messages. You can't do anything else: you can't read or post in other channels, browse the web, open links or files, run code or set reminders. When asked to, say plainly that you can't do that here, then help with what you can.",
    "Write only your reply to the latest message, in plain text or Markdown. Be concise and direct, and don't start with your name.",
    ...(own ? [`Your owner's instructions:\n${own}`] : []),
  ].join("\n\n");
}

/** The prompt: the conversation's earlier messages, as many of the newest as
 * fit, then the one to answer, clipped to `latestChars`. */
export function prompt(
  input: Readonly<{
    place: string;
    earlier: readonly Line[];
    latest: Line;
    latestChars?: number;
  }>,
) {
  const kept: string[] = [];
  let used = 0;
  for (let at = input.earlier.length - 1; at >= 0; at--) {
    const line = input.earlier[at];
    if (!line) continue;
    const text = `${line.author}: ${clip(line.text, MESSAGE_CHARS)}`;
    if (used + text.length > CONTEXT_CHARS) break;
    kept.unshift(text);
    used += text.length + 1;
  }
  return [
    ...(kept.length
      ? [`Earlier messages in ${input.place}:`, kept.join("\n"), ""]
      : []),
    `Latest message in ${input.place}, from ${input.latest.author}:`,
    clip(input.latest.text, input.latestChars ?? LATEST_CHARS),
  ].join("\n");
}

/** Whether `fm` failed because the prompt did not fit the model's context. */
export const overflowed = (error: string) => /context size/i.test(error);

/** `fm`'s error output as one line for the owner, without its prefix. */
export function errorLine(output: string, code: number | null) {
  const line = output
    // biome-ignore lint/suspicious/noControlCharactersInRegex: fm colours its usage errors.
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((text) => text.trim())
    .find(Boolean)
    ?.replace(/^Error:\s*/, "");
  return line || `fm exited with ${code === null ? "a signal" : code}`;
}
