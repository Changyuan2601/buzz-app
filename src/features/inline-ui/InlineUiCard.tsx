import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type { InlineUi } from "./patterns";

/** A message's pattern controls. Only the conversation's newest message is
 * live: any later message, an answer or the agent moving on, retires it, so
 * the chat itself decides on every device. A retired pattern shows nothing;
 * the message text and the answer below it remain. */
export function InlineUiCard({
  ui,
  live,
  onPick,
  className,
}: {
  ui: InlineUi;
  live: boolean;
  /** Sends the pick as the viewer's ordinary reply. */
  onPick(answer: string): Promise<unknown> | unknown;
  /** The row's layout slot for content below the message. */
  className?: string | undefined;
}) {
  const [picked, setPicked] = useState(false);
  const [error, setError] = useState("");
  if (!live) return null;
  const pick = async (answer: string) => {
    if (picked) return;
    setPicked(true);
    setError("");
    try {
      await onPick(answer);
    } catch (reason) {
      setPicked(false);
      setError(
        reason instanceof Error ? reason.message : "Couldn't send. Try again.",
      );
    }
  };
  return (
    <div className={className}>
      {ui.options.map((option) => (
        <Button
          key={option}
          disabled={picked}
          onClick={() => void pick(option)}
        >
          {option}
        </Button>
      ))}
      <p className="text-body-sm text-subtle">Or type your own answer.</p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
