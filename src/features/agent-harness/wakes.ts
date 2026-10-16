// Watch and timer wakes, the same for every harness, as in Janet: each runs as
// a standalone turn in its Interest's lane, joins no conversation, and saves
// nothing. The agent runner owns the lanes; an agent type supplies only how to
// run one standalone turn (`AgentType.runOnce`). This owns the checks that the
// wake is still wanted, and its prompt.
import {
  ATTENTION_REVIEW,
  catchUpPrompt,
  timerPrompt,
  watchPrompt,
} from "./attention-prompt";
import type { AgentHandle, Trigger, TurnResult } from "../agents/service";

export type WakeTrigger = Exclude<Trigger, { type: "mention" }>;
/** Runs one standalone turn, `key` naming it (`watch/ID`, `catch-up/ID` or
 * `timer/ID`). It calls `prompt` once it is ready to start the turn, and
 * starts none when it gives undefined: the wake is no longer wanted. */
export type RunOnce = (
  key: string,
  prompt: () => Promise<string | undefined>,
) => Promise<TurnResult>;

/** Runs `trigger` with `runOnce`, in the lane the runner holds for it.
 * Settles when its turn ends, or at once when it no longer runs. The host
 * says whether it is still `current`, asked as it starts and again while its
 * prompt is built: a wake whose watch or timer was disabled or removed, whose
 * watch changed or no longer matches, or whose agent's attention went off,
 * while it waited does not run. `harness` names the agent type in logs. */
export async function wake(
  agent: AgentHandle,
  trigger: WakeTrigger,
  current: () => boolean,
  runOnce: RunOnce,
  harness: string,
): Promise<TurnResult> {
  const id = trigger.slug.replace(/^watch\//, "");
  if (!current()) return { ok: true };
  try {
    const result = await runOnce(`${trigger.type}/${id}`, () =>
      wakePrompt(agent, trigger, id, current),
    );
    if (!result.ok)
      console.warn(
        `${harness} ${trigger.type} turn failed: ${id}`,
        result.error,
      );
    return result;
  } catch (error) {
    console.warn(`${harness} ${trigger.type} turn failed: ${id}`, error);
    return { ok: false, error: "The turn failed" };
  }
}

/** The prompt for a wake as its watch or timer now is, with the end-of-turn
 * review, or undefined when it should no longer run. */
async function wakePrompt(
  agent: AgentHandle,
  trigger: WakeTrigger,
  id: string,
  stillCurrent: () => boolean,
) {
  const { attention } = agent;
  if (!stillCurrent()) return undefined;
  const current = (await attention.show(trigger.slug)).object;
  const type = trigger.type === "timer" ? "timer" : "event";
  if (!current || current.type !== type) return undefined;
  const interest = (await attention.show(`interest/${current.interest_id}`))
    .object;
  const instructions =
    interest?.type === "interest"
      ? { instructions: interest.instructions }
      : {};
  const text =
    trigger.type === "watch"
      ? watchPrompt({
          id,
          interest: current.interest_id,
          ...instructions,
          event: trigger.event,
          ...(trigger.classifier ? { classifier: trigger.classifier } : {}),
        })
      : trigger.type === "catch-up"
        ? catchUpPrompt({
            id,
            interest: current.interest_id,
            ...instructions,
            events: trigger.events,
            skipped: !!trigger.skipped,
          })
        : timerPrompt({
            id,
            interest: current.interest_id,
            prompt: current.type === "timer" ? current.prompt : "",
            ...instructions,
            spent: trigger.spent,
          });
  // Asked again: the attention can change while it is read.
  return stillCurrent() ? `${text}\n\n${ATTENTION_REVIEW}` : undefined;
}
