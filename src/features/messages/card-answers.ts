import type { ChannelMessage } from "../relay/contracts";

/** The longest reply a choice card can show as its written answer. */
const MAX_ANSWER = 500;
const NONE: ReadonlyMap<string, string> = new Map();

/** The viewer's reply right after an agent's choice card answers it, and the
 * card shows that answer, so the reply's own bubble would only repeat it.
 * Answers are taken out of the rows and given to their cards. A reply the
 * card can't show whole (several lines, or too long), a thread reply, or one
 * that hasn't been delivered stays as an ordinary message. */
export function cardAnswers(
  rows: readonly ChannelMessage[],
  viewer: string | undefined,
  agents: ReadonlySet<string>,
): Readonly<{
  rows: readonly ChannelMessage[];
  /** Each answered card's answer. */
  answers: ReadonlyMap<string, string>;
  /** Each taken-out reply's card. */
  cards: ReadonlyMap<string, string>;
}> {
  const answers = new Map<string, string>();
  const cards = new Map<string, string>();
  rows.forEach((card, index) => {
    const reply = rows[index + 1];
    if (
      !viewer ||
      !reply ||
      card.threadRootId ||
      card.inlineUi?.ui.pattern !== "choice" ||
      !agents.has(card.authorId) ||
      reply.authorId !== viewer ||
      reply.threadRootId ||
      reply.membership ||
      reply.attachments.length > 0 ||
      reply.delivery === "failed" ||
      reply.delivery === "unknown" ||
      reply.content.includes("\n") ||
      reply.content.length > MAX_ANSWER
    )
      return;
    answers.set(card.id, reply.content);
    cards.set(reply.id, card.id);
  });
  // Unchanged rows keep their identity, so the timeline doesn't reposition.
  return cards.size
    ? { rows: rows.filter((row) => !cards.has(row.id)), answers, cards }
    : { rows, answers: NONE, cards: NONE };
}
