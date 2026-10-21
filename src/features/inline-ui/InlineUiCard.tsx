import { useContext, useRef, useState } from "react";
import { randomAgentAvatar } from "../agents/avatar-packs";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import {
  Radio,
  RadioGroup,
  RadioWriteIn,
} from "../../shared/design-system/ui/RadioGroup";
import styles from "./InlineUiCard.module.css";
import { InlineUiHost } from "./host";
import type { InlineUi } from "./patterns";

const OWN = "\u0000own";

/** An answer a retired pattern stays frozen on. */
export type InlineUiAnswer = Readonly<{
  text: string;
  picture?: string | undefined;
}>;

/** A message's pattern controls. Only the conversation's newest message is
 * live: any later message, an answer or the agent moving on, retires it, so
 * the chat itself decides on every device. A retired pattern that was
 * answered stays as a frozen card with that answer selected; one the chat
 * moved past unanswered shows nothing. */
export function InlineUiCard({
  ui,
  agent,
  live,
  reply,
  author,
  onReply,
  className,
}: {
  ui: InlineUi;
  /** The agent that sent the pattern. */
  agent: string;
  live: boolean;
  /** The owner's reply right after it, which answers a choice. */
  reply?: string | undefined;
  /** The agent's name and picture now, which answer a saved profile. */
  author?: InlineUiAnswer | undefined;
  /** Sends a choice as the viewer's ordinary reply. */
  onReply(answer: string): Promise<unknown> | unknown;
  /** The row's layout slot for content below the message. */
  className?: string | undefined;
}) {
  const { saveProfile, profileSaved } = useContext(InlineUiHost);
  if (!live || (ui.pattern === "profile" && !saveProfile)) {
    const answered =
      ui.pattern === "profile"
        ? profileSaved
          ? author
          : undefined
        : reply
          ? { text: reply }
          : undefined;
    // Unkeyed, so a card answered here stays mounted and collapses smoothly.
    return answered ? (
      <ChoiceForm ui={ui} className={className} answered={answered} />
    ) : null;
  }
  return (
    <ChoiceForm
      ui={ui}
      className={className}
      onSubmit={(answer, picture) =>
        ui.pattern === "profile" && saveProfile
          ? saveProfile(agent, { name: answer, picture })
          : onReply(answer)
      }
    />
  );
}

function ChoiceForm({
  ui,
  className,
  answered,
  onSubmit,
}: {
  ui: InlineUi;
  className?: string | undefined;
  /** Frozen on this answer: nothing can change or be submitted. */
  answered?: InlineUiAnswer | undefined;
  onSubmit?(answer: string, picture: string): Promise<unknown> | unknown;
}) {
  const profile = ui.pattern === "profile";
  const [avatar, setAvatar] = useState(randomAgentAvatar);
  // Shuffle turns the avatar edge-on, swaps in the preloaded next one out
  // of sight, and turns it back, so no frame shows a missing image.
  const [turn, setTurn] = useState<"out" | "in">();
  const next = useRef<{
    avatar: ReturnType<typeof randomAgentAvatar>;
    ready: Promise<unknown>;
  }>(undefined);
  const frozen = !!answered;
  const [picked, setChoice] = useState<string | null>(null);
  const [typed, setOwn] = useState("");
  // Only a card answered while open has Shuffle and Submit to close.
  const [answeredHere] = useState(!answered);
  // A frozen card shows its answer, whatever was picked or typed before.
  const choice = !answered
    ? picked
    : ui.options.includes(answered.text)
      ? answered.text
      : OWN;
  const own = answered && choice === OWN ? answered.text : typed;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answer = (choice === OWN ? own : (choice ?? "")).trim();
  return (
    <div className={className}>
      <form
        className={styles.card}
        aria-label={profile ? "Name and avatar" : "Answer"}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !answer || !onSubmit) return;
          setBusy(true);
          setError("");
          try {
            await onSubmit(answer, avatar.url);
          } catch (reason) {
            setError(
              reason instanceof Error
                ? reason.message
                : "Couldn't send. Try again.",
            );
            setBusy(false);
          }
        }}
      >
        {profile && (
          <div className={styles.avatarRow}>
            <div
              className={styles.avatar}
              data-turn={turn}
              onAnimationEnd={() => {
                if (turn === "in") return setTurn(undefined);
                const pending = next.current;
                void pending?.ready.then(() => {
                  setAvatar(pending.avatar);
                  setTurn("in");
                });
              }}
            >
              {answered ? (
                <Avatar
                  size="fill"
                  src={answered.picture}
                  alt={answered.text}
                  fallback={answered.text}
                />
              ) : (
                <Avatar
                  size="fill"
                  src={avatar.preview}
                  alt={avatar.label}
                  fallback={avatar.label}
                />
              )}
            </div>
            {(!frozen || answeredHere) && (
              <div className={styles.shuffle} {...collapse(frozen)}>
                <Button
                  variant="prominent"
                  size="sm"
                  disabled={busy || !!turn}
                  onClick={() => {
                    let pick = randomAgentAvatar();
                    while (pick.id === avatar.id) pick = randomAgentAvatar();
                    const image = new Image();
                    image.src = pick.preview ?? "";
                    next.current = {
                      avatar: pick,
                      ready:
                        image.decode?.().catch(() => {}) ?? Promise.resolve(),
                    };
                    setTurn("out");
                  }}
                >
                  Shuffle
                </Button>
              </div>
            )}
          </div>
        )}
        <div className={styles.choices}>
          <Field label={profile ? "Name" : "Answer"} labelVisibility="hidden">
            <RadioGroup<string | null>
              value={choice === OWN ? null : choice}
              disabled={busy}
              readOnly={frozen}
              onValueChange={setChoice}
            >
              {ui.options.map((option) => (
                <div
                  key={option}
                  className={styles.collapsible}
                  {...collapse(frozen && option !== choice)}
                >
                  <div className={styles.collapsibleContent}>
                    <Radio value={option} label={option} variant="tile" />
                  </div>
                </div>
              ))}
            </RadioGroup>
          </Field>
          <div
            className={styles.collapsible}
            {...collapse(frozen && choice !== OWN)}
          >
            <div className={styles.collapsibleContent}>
              <RadioWriteIn
                aria-label="Write your own"
                placeholder="Write your own"
                selected={choice === OWN}
                value={own}
                disabled={busy}
                readOnly={frozen}
                maxLength={profile ? 64 : 500}
                onFocus={() => setChoice(OWN)}
                onChange={(event) => setOwn(event.target.value)}
              />
            </div>
          </div>
        </div>
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
        {(!frozen || answeredHere) && (
          <div className={styles.collapsibleEnd} {...collapse(frozen)}>
            <div className={styles.collapsibleContent}>
              <div className={styles.actions}>
                <Button
                  type="submit"
                  variant="prominent"
                  loading={busy}
                  disabled={!answer}
                >
                  Submit
                </Button>
              </div>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

/** Answering closes what wasn't chosen like an accordion: it fades, then its
 * space closes. Closed parts leave the accessibility tree and focus order. */
function collapse(closed: boolean) {
  return closed
    ? { "data-collapsed": "", "aria-hidden": true, inert: true }
    : {};
}
