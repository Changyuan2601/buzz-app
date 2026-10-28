import { useState, type RefObject } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import {
  PopoverDescription,
  PopoverPopup,
  PopoverRoot,
  PopoverTitle,
} from "../../shared/design-system/ui/Popover";

export type RecipientTipKind = "main-agent" | "no-agents";

const seenKey = (kind: RecipientTipKind) => `buzz-solo-tip-${kind}.v1`;

function seen(kind: RecipientTipKind) {
  try {
    return localStorage.getItem(seenKey(kind)) === "seen";
  } catch {
    return true; // Without storage it could never stay dismissed.
  }
}

/** A one-time hint beside Solo's recipients, shown until it is dismissed. */
export function RecipientTip({
  kind,
  agent,
  anchor,
}: {
  kind: RecipientTipKind | undefined;
  agent?: string | undefined;
  anchor: RefObject<HTMLElement | null>;
}) {
  const [dismissed, setDismissed] = useState<readonly RecipientTipKind[]>([]);
  const open = !!kind && !dismissed.includes(kind) && !seen(kind);
  if (!kind || !open) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(seenKey(kind), "seen");
    } catch {}
    setDismissed((list) => [...list, kind]);
  };
  return (
    <PopoverRoot
      open
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <PopoverPopup
        anchor={anchor}
        side="top"
        size="compact"
        initialFocus={false}
        finalFocus={false}
      >
        {kind === "main-agent" ? (
          <>
            <PopoverTitle>Messages go to your main agent</PopoverTitle>
            <PopoverDescription>
              {agent ? `${agent} is` : "Your main agent is"} added whenever you
              come back to a chat here. Use @ to add another agent, or click an
              avatar to remove it.
            </PopoverDescription>
          </>
        ) : (
          <>
            <PopoverTitle>Make an agent to start</PopoverTitle>
            <PopoverDescription>
              Solo messages go to your agents. Make one on the Agents page, and
              it’s added here as your main agent.
            </PopoverDescription>
          </>
        )}
        <Button size="sm" onClick={dismiss}>
          Got it
        </Button>
      </PopoverPopup>
    </PopoverRoot>
  );
}
