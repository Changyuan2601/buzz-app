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

/** A message's pattern controls. Only the conversation's newest message is
 * live: any later message, an answer or the agent moving on, retires it, so
 * the chat itself decides on every device. A retired pattern shows nothing;
 * the message text and what followed it remain. */
export function InlineUiCard({
  ui,
  agent,
  live,
  onReply,
  className,
}: {
  ui: InlineUi;
  /** The agent that sent the pattern. */
  agent: string;
  live: boolean;
  /** Sends a choice as the viewer's ordinary reply. */
  onReply(answer: string): Promise<unknown> | unknown;
  /** The row's layout slot for content below the message. */
  className?: string | undefined;
}) {
  const { saveProfile } = useContext(InlineUiHost);
  if (!live || (ui.pattern === "profile" && !saveProfile)) return null;
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
  onSubmit,
}: {
  ui: InlineUi;
  className?: string | undefined;
  onSubmit(answer: string, picture: string): Promise<unknown> | unknown;
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
  const [choice, setChoice] = useState<string | null>(null);
  const [own, setOwn] = useState("");
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
          if (busy || !answer) return;
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
              <Avatar
                size="fill"
                src={avatar.preview}
                alt={avatar.label}
                fallback={avatar.label}
              />
            </div>
            <div className={styles.shuffle}>
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
          </div>
        )}
        <div className={styles.choices}>
          <Field label={profile ? "Name" : "Answer"} labelVisibility="hidden">
            <RadioGroup<string | null>
              value={choice === OWN ? null : choice}
              disabled={busy}
              onValueChange={setChoice}
            >
              {ui.options.map((option) => (
                <Radio
                  key={option}
                  value={option}
                  label={option}
                  variant="tile"
                />
              ))}
            </RadioGroup>
          </Field>
          <RadioWriteIn
            aria-label="Write your own"
            placeholder="Write your own"
            selected={choice === OWN}
            value={own}
            disabled={busy}
            maxLength={profile ? 64 : 500}
            onFocus={() => setChoice(OWN)}
            onChange={(event) => setOwn(event.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
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
      </form>
    </div>
  );
}
