import { useContext, useState } from "react";
import { randomAgentAvatar } from "../agents/avatar-packs";
import { ArrowsShuffleIcon } from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
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
  const [choice, setChoice] = useState<string | null>(null);
  const [own, setOwn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answer = (choice === OWN ? own : (choice ?? "")).trim();
  return (
    <form
      className={className}
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
        <div className="flex items-center gap-2">
          <Avatar
            size="large"
            shape="squircle"
            src={avatar.preview}
            alt={avatar.label}
            fallback={avatar.label}
          />
          <IconButton
            aria-label="Shuffle avatar"
            icon={<ArrowsShuffleIcon size={16} />}
            disabled={busy}
            onClick={() => {
              let next = randomAgentAvatar();
              while (next.id === avatar.id) next = randomAgentAvatar();
              setAvatar(next);
            }}
          />
        </div>
      )}
      <Field label={profile ? "Name" : "Answer"} labelVisibility="hidden">
        <RadioGroup<string | null>
          value={choice}
          disabled={busy}
          onValueChange={setChoice}
        >
          {ui.options.map((option) => (
            <Radio key={option} value={option} label={option} />
          ))}
          <Radio value={OWN} label="Write your own" />
        </RadioGroup>
      </Field>
      {choice === OWN && (
        <Field label={profile ? "Your name for me" : "Your answer"}>
          <Input
            autoFocus
            value={own}
            disabled={busy}
            maxLength={profile ? 64 : 500}
            onChange={(event) => setOwn(event.target.value)}
          />
        </Field>
      )}
      <Button
        type="submit"
        variant="prominent"
        loading={busy}
        disabled={!answer}
      >
        Submit
      </Button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
