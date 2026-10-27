import { useRef, useState, type ReactElement } from "react";
import { agentAvatars } from "../../features/agents/avatar-packs";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuNote,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { formatPublicKey } from "../../shared/identity/public-key";
import { bestieName, type BestieAgent } from "./state";

type Size = "small" | "default" | "large";

/** Resolve the same agent artwork in the page and host navigation. */
export function useBestieAvatar(
  agent: BestieAgent | undefined,
  community?: string,
) {
  const pack = agentAvatars.find((avatar) => avatar.url === agent?.avatar);
  const picture = useAvatarPreview(
    pack ? "" : (agent?.avatar ?? ""),
    community,
    "small",
  );
  return pack?.preview ?? picture;
}

/** An agent's own portrait, through this community's media access. It says
 * nothing about whether the agent is owned, online or running. */
export function BestiePortrait({
  agent,
  community,
  size = "small",
}: {
  agent: BestieAgent;
  community?: string | undefined;
  size?: Size;
}) {
  const picture = useBestieAvatar(agent, community);
  return (
    <Avatar
      src={picture}
      alt=""
      fallback={bestieName(agent)}
      size={size}
      shape="squircle"
    />
  );
}

/** Picking a Bestie, from the setup state and from the page header. The menu
 * owns keyboard selection; replacing one confirms first and names what moves. */
export function BestieChoice({
  agents,
  current,
  community,
  trigger,
  align = "start",
  onChoose,
}: {
  agents: readonly BestieAgent[];
  /** The Bestie in place, marked in the list; absent before the first pick. */
  current?: BestieAgent | undefined;
  community?: string | undefined;
  trigger: ReactElement;
  align?: "start" | "end";
  onChoose(agent: BestieAgent): void;
}) {
  const [replacing, setReplacing] = useState<BestieAgent>();
  const [open, setOpen] = useState(false);
  const choose = (pubkey: string) => {
    const agent = agents.find((item) => item.pubkey === pubkey);
    if (!agent || agent.pubkey === current?.pubkey) return;
    // Replacing a Bestie moves where messages for an agent go: confirm first.
    // The menu closes with the same click, so the dialog owns focus from here.
    if (current) {
      setOpen(false);
      setReplacing(agent);
    } else onChoose(agent);
  };
  return (
    <>
      <MenuRoot open={open} onOpenChange={setOpen}>
        <MenuTrigger render={trigger} />
        <MenuPopup align={align} aria-label="Choose main agent">
          <MenuGroup>
            <MenuGroupLabel emphasis="quiet">Your agents</MenuGroupLabel>
            <MenuRadioGroup
              value={current?.pubkey ?? ""}
              onValueChange={choose}
            >
              {agents.map((agent) => (
                <MenuRadioItem
                  key={agent.pubkey}
                  value={agent.pubkey}
                  closeOnClick
                >
                  <ChoiceRow
                    leading={
                      <BestiePortrait agent={agent} community={community} />
                    }
                    label={bestieName(agent)}
                    description={formatPublicKey(agent.pubkey)}
                  />
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          {!agents.length && (
            <MenuNote>No agents to choose from in this community.</MenuNote>
          )}
        </MenuPopup>
      </MenuRoot>
      {replacing && current && (
        <BestieConfirmation
          current={current}
          replacing={replacing}
          onChoose={onChoose}
          onClose={() => setReplacing(undefined)}
        />
      )}
    </>
  );
}

/** Both the Agents actions and the Bestie picker explain the same replacement. */
export function BestieConfirmation({
  current,
  replacing,
  onChoose,
  onClose,
}: {
  current: BestieAgent;
  replacing: BestieAgent;
  onChoose(agent: BestieAgent): void;
  onClose(): void;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      title={`Make ${bestieName(replacing)} your main agent?`}
      description={`${bestieName(replacing)} replaces ${bestieName(current)} here, and new chats are addressed to ${bestieName(replacing)}. Your chat with ${bestieName(current)} stays in your chats.`}
      initialFocus={keep}
      onClose={() => onClose()}
      actions={
        <>
          <Button ref={keep} onClick={() => onClose()}>
            Keep {bestieName(current)}
          </Button>
          <Button
            variant="prominent"
            onClick={() => {
              onChoose(replacing);
              onClose();
            }}
          >
            Make main agent
          </Button>
        </>
      }
    />
  );
}
