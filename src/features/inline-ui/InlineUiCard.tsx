import { useContext, useLayoutEffect, useRef, useState } from "react";
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
  // Answering closes what wasn't chosen like an accordion: it fades, then
  // it is gone and the card eases to its new height. A card that arrives
  // answered starts closed.
  const [phase, setPhase] = useState<"open" | "closed">(
    answered ? "closed" : "open",
  );
  const form = useRef<HTMLFormElement>(null);
  const from = useRef<number>(undefined);
  useLayoutEffect(() => {
    const card = form.current;
    if (!frozen || phase !== "open" || !card) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      return setPhase("closed");
    const timer = setTimeout(
      () => {
        from.current = card.offsetHeight;
        setPhase("closed");
      },
      cssTime(card, "--duration-fast"),
    );
    return () => clearTimeout(timer);
  }, [frozen, phase]);
  useLayoutEffect(() => {
    const card = form.current;
    const start = from.current;
    if (phase !== "closed" || !card || start === undefined) return;
    from.current = undefined;
    const end = card.offsetHeight;
    if (end === start || !card.animate) return;
    card.style.overflow = "clip";
    const resize = card.animate(
      [{ height: `${start}px` }, { height: `${end}px` }],
      {
        duration: cssTime(card, "--duration-settle"),
        easing: getComputedStyle(card).getPropertyValue("--easing-settle"),
      },
    );
    const done = () => card.style.removeProperty("overflow");
    resize.onfinish = done;
    resize.oncancel = done;
    return () => resize.cancel();
  }, [phase]);
  const open = phase !== "closed";
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
        ref={form}
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
            {open && (
              <div className={styles.shuffle} {...fade(frozen)}>
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
              disabled={busy && !frozen}
              readOnly={frozen}
              onValueChange={setChoice}
            >
              {ui.options
                .filter((option) => open || option === choice)
                .map((option) => (
                  <div
                    key={option}
                    className={styles.fade}
                    {...fade(frozen && option !== choice)}
                  >
                    <Radio value={option} label={option} variant="tile" />
                  </div>
                ))}
            </RadioGroup>
          </Field>
          {(open || choice === OWN) && (
            <div className={styles.fade} {...fade(frozen && choice !== OWN)}>
              <RadioWriteIn
                aria-label="Write your own"
                placeholder="Write your own"
                selected={choice === OWN}
                value={own}
                disabled={busy && !frozen}
                readOnly={frozen}
                maxLength={profile ? 64 : 500}
                onFocus={() => setChoice(OWN)}
                onChange={(event) => setOwn(event.target.value)}
              />
            </div>
          )}
        </div>
        {error && !frozen && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
        {open && (
          <div className={styles.actions} {...fade(frozen)}>
            <Button
              type="submit"
              variant="prominent"
              loading={busy && !frozen}
              disabled={!answer}
            >
              Submit
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}

/** Marks a part that wasn't chosen as fading out: out of reach at once. */
function fade(gone: boolean) {
  return gone ? { "data-fading": "", "aria-hidden": true, inert: true } : {};
}

/** A design-system duration token, in milliseconds. */
function cssTime(element: Element, token: string) {
  const value = getComputedStyle(element).getPropertyValue(token).trim();
  const time = Number.parseFloat(value);
  return Number.isNaN(time) ? 0 : value.endsWith("ms") ? time : time * 1000;
}
