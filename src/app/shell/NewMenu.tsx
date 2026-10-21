import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PlusIcon } from "../../shared/design-system/icons";
import { splitPartition } from "../../features/relay/partition";
import { useRelayConnection } from "../../features/relay/react";
import type { Agents } from "../../features/agents/service";
import type { Navigation } from "../../features/navigation/controller";
import type { RelayData } from "../../features/relay/service";
import styles from "./NewMenu.module.css";

export function NewMenu({
  relay,
  navigator,
}: {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
}) {
  const connection = useRelayConnection(relay);
  const session = connection.session;
  const disabled =
    connection.status !== "ready" || !session.channelCreation.available;
  const openDraft = () => {
    const scope = splitPartition(session.scope);
    if (scope)
      void navigator.open({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
        scope,
        route: { version: 1, params: "new-chat-recipient" },
      });
  };
  return (
    <>
      <span className={styles.compactCreation}>
        <IconButton
          size="large"
          variant="tint"
          aria-label="New chat"
          title="New chat (⌘N)"
          disabled={disabled}
          icon={<PlusIcon size={24} />}
          onClick={openDraft}
        />
      </span>
      <div className={styles.expandedCreation}>
        <NavigationItem
          variant="rail"
          label="New"
          aria-label="New chat"
          icon={
            <span className={styles.creationArtwork}>
              <PlusIcon size={24} aria-hidden="true" />
            </span>
          }
          disabled={disabled}
          onClick={openDraft}
        />
      </div>
    </>
  );
}
