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
  const {
    saveProfile,
    profileSaved,
    answered: handOff,
  } = useContext(InlineUiHost);
  // Naming the agent unlocks its chat, so a name card stays usable until it
  // is saved, whatever comes after it.
  const usable = ui.pattern === "profile" ? !!saveProfile : live;
  if (!usable) {
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
      onAnswered={handOff}
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
  onAnswered,
}: {
  ui: InlineUi;
  className?: string | undefined;
  /** Frozen on this answer: nothing can change or be submitted. */
  answered?: InlineUiAnswer | undefined;
  onSubmit?(answer: string, picture: string): Promise<unknown> | unknown;
  /** Takes focus as the submitted card's controls close. */
  onAnswered?: (() => void) | undefined;
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
  // Submitting closes the card at once on what was sent, so it never shows
  // a pending state; a failed send reopens it with the error.
  const [sent, setSent] = useState<InlineUiAnswer>();
  const shown = sent ?? answered;
  const frozen = !!shown;
  const [picked, setChoice] = useState<string | null>(null);
  const [typed, setOwn] = useState("");
  // Answering closes what wasn't chosen like an accordion: each part fades
  // while its space and the gap before it close, together, on the
  // accordion's timing; then the parts are gone. A card that arrives
  // answered starts closed.
  const [phase, setPhase] = useState<"open" | "closed">(
    answered ? "closed" : "open",
  );
  const form = useRef<HTMLFormElement>(null);
  // Set when a failed send reopens a card that held focus, until it is back.
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (!refocus.current || frozen || phase !== "open") return;
    refocus.current = false;
    form.current?.querySelector<HTMLElement>('button[type="submit"]')?.focus();
  }, [frozen, phase]);
  useLayoutEffect(() => {
    const card = form.current;
    if (!frozen || phase !== "open" || !card) return;
    const parts = [...card.querySelectorAll<HTMLElement>("[data-closing]")];
    if (
      !card.animate ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return setPhase("closed");
    const timing = {
      duration: cssTime(card, "--duration-settle"),
      easing: getComputedStyle(card).getPropertyValue("--easing-settle"),
      fill: "forwards" as const,
    };
    const closing = parts.map((part) => {
      if (part.dataset.closing === "fade")
        return part.animate([{ opacity: 1 }, { opacity: 0 }], timing);
      const gap =
        Number.parseFloat(
          part.parentElement ? getComputedStyle(part.parentElement).rowGap : "",
        ) || 0;
      part.style.overflow = "clip";
      return part.animate(
        [
          { height: `${part.offsetHeight}px`, marginTop: "0px", opacity: 1 },
          { height: "0px", marginTop: `${-gap}px`, opacity: 0 },
        ],
        timing,
      );
    });
    let current = true;
    void Promise.all(closing.map((animation) => animation.finished)).then(
      () => current && setPhase("closed"),
      () => {},
    );
    return () => {
      current = false;
      for (const animation of closing) animation.cancel();
      for (const part of parts) part.style.removeProperty("overflow");
    };
  }, [frozen, phase]);
  const open = phase !== "closed";
  // A frozen card shows its answer, whatever was picked or typed before.
  const choice = !shown
    ? picked
    : ui.options.includes(shown.text)
      ? shown.text
      : OWN;
  const own = shown && choice === OWN ? shown.text : typed;
  const [error, setError] = useState("");
  const answer = (choice === OWN ? own : (choice ?? "")).trim();
  const ownLabel = profile ? "Name" : "Answer";
  // A failed send shows under the control that was answered.
  const ownError = choice === OWN || !ui.options.length;
  return (
    <div className={className} data-inline-card="" data-no-timestamp-hint="">
      <form
        ref={form}
        className={styles.card}
        data-answered={frozen || undefined}
        aria-label={profile ? "Name and avatar" : "Answer"}
        onSubmit={async (event) => {
          event.preventDefault();
          if (frozen || !answer || !onSubmit) return;
          setError("");
          setSent({ text: answer, picture: avatar.preview ?? avatar.url });
          const held = !!form.current?.contains(document.activeElement);
          // Focus would otherwise go down with the closing controls. A
          // profile save hands it on only once it succeeds, since the
          // destination stays disabled until then; a failure keeps it here.
          if (held && !profile) onAnswered?.();
          try {
            await onSubmit(answer, avatar.url);
            if (held && profile) onAnswered?.();
          } catch (reason) {
            refocus.current = held;
            setError(
              reason instanceof Error
                ? reason.message
                : "Couldn't send. Try again.",
            );
            setSent(undefined);
            setPhase("open");
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
              {shown ? (
                <Avatar
                  size="fill"
                  src={shown.picture}
                  alt={shown.text}
                  fallback={shown.text}
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
              <div className={styles.shuffle} {...closing(frozen, "fade")}>
                <Button
                  variant="prominent"
                  size="sm"
                  disabled={frozen || !!turn}
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
          {ui.options.length > 0 && (open || choice !== OWN) && (
            <div {...closing(frozen && choice === OWN)}>
              <Field
                label={profile ? "Name" : "Answer"}
                labelVisibility="hidden"
                error={!frozen && !ownError ? error : undefined}
              >
                <RadioGroup<string | null>
                  value={choice === OWN ? null : choice}
                  readOnly={frozen}
                  onValueChange={setChoice}
                >
                  {ui.options
                    .filter((option) => open || option === choice)
                    .map((option) => (
                      <div
                        key={option}
                        {...closing(
                          frozen && choice !== OWN && option !== choice,
                        )}
                      >
                        <Radio value={option} label={option} variant="tile" />
                      </div>
                    ))}
                </RadioGroup>
              </Field>
            </div>
          )}
          {(open || choice === OWN) && (
            <div {...closing(frozen && choice !== OWN)}>
              <Field
                label={
                  ui.options.length && !frozen ? "Write your own" : ownLabel
                }
                labelVisibility="hidden"
                error={!frozen && ownError ? error : undefined}
              >
                {frozen ? (
                  // A written answer shows whole, as a chosen option does.
                  <RadioGroup<string> value={own} readOnly>
                    <Radio value={own} label={own} variant="tile" />
                  </RadioGroup>
                ) : (
                  <RadioWriteIn
                    aria-label={ui.options.length ? "Write your own" : ownLabel}
                    placeholder={
                      ui.options.length ? "Write your own" : ownLabel
                    }
                    selected={choice === OWN}
                    value={own}
                    maxLength={profile ? 64 : 500}
                    onFocus={() => setChoice(OWN)}
                    onChange={(event) => setOwn(event.target.value)}
                  />
                )}
              </Field>
            </div>
          )}
        </div>
        {open && (
          <div {...closing(frozen)}>
            <div className={styles.actions}>
              <Button type="submit" variant="prominent" disabled={!answer}>
                Submit
              </Button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

/** Marks a part that wasn't chosen as closing, out of reach at once. It
 * collapses its space, or only fades where it holds no space of its own. */
function closing(gone: boolean, how: "collapse" | "fade" = "collapse") {
  return gone ? { "data-closing": how, "aria-hidden": true, inert: true } : {};
}

/** A design-system duration token, in milliseconds. */
function cssTime(element: Element, token: string) {
  const value = getComputedStyle(element).getPropertyValue(token).trim();
  const time = Number.parseFloat(value);
  return Number.isNaN(time) ? 0 : value.endsWith("ms") ? time : time * 1000;
}
