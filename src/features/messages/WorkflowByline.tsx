import { npubEncode } from "nostr-tools/nip19";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { InfoIcon } from "../../shared/design-system/icons";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
} from "../../shared/design-system/ui/Popover";
import { profileTarget } from "../profiles/target";
import styles from "./Messages.module.css";

export function WorkflowByline({
  ownerId,
  ownerName,
  signer,
  canOpenLink,
  onOpenLink,
}: {
  ownerId: string;
  ownerName: string;
  signer: string;
  canOpenLink?: ((url: string) => boolean) | undefined;
  onOpenLink(url: string): boolean;
}) {
  const target = profileTarget(ownerId);
  return (
    <span className={styles.workflowAttribution}>
      <strong className={styles.author}>Workflow</strong>
      <span className={styles.workflowOwner}>
        <span aria-hidden="true">· </span>owned by{" "}
        {target && canOpenLink?.(target) ? (
          <Button
            variant="link"
            size="inline"
            aria-label={`View workflow owner ${ownerName} profile`}
            onClick={() => onOpenLink(target)}
          >
            {ownerName}
          </Button>
        ) : (
          ownerName
        )}
      </span>
      <PopoverRoot>
        <PopoverTrigger
          render={
            <IconButton
              size="xs"
              variant="ghost"
              aria-label="Workflow message details"
              icon={<InfoIcon />}
            />
          }
        />
        <PopoverPopup size="compact">
          <PopoverTitle>Workflow message</PopoverTitle>
          <PopoverDescription>
            Sent automatically. This community’s relay attributes the workflow
            to this owner; the owner did not sign this message.
          </PopoverDescription>
          <dl className={styles.workflowDetails}>
            <dt>Workflow owner</dt>
            <dd>{ownerName}</dd>
            <dt>Owner public key</dt>
            <dd>{npubEncode(ownerId)}</dd>
            <dt>Signed by the relay</dt>
            <dd>{npubEncode(signer)}</dd>
          </dl>
          <p className="text-body-sm text-tertiary">
            Workflow and run details are not included in this message.
          </p>
        </PopoverPopup>
      </PopoverRoot>
    </span>
  );
}
