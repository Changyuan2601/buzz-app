import { useRef, useState, useSyncExternalStore } from "react";
import type { Agents } from "../../features/agents/service";
import { CreateChannelDialog } from "../../bundled/channels/CreateChannelDialog";
import { revealCreatedChannel } from "../../features/channel-navigation/created-channel";
import { useSidebarPreferences } from "../../bundled/channels/useSidebarPreferences";
import type { Navigation } from "../../features/navigation/controller";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { splitPartition } from "../../features/relay/partition";
import { NewWorkspace } from "../../features/solo/NewWorkspace";
import { resetNewChatProject } from "../../features/solo/SoloDraft";
import { soloDraftTarget } from "../../features/channel-navigation/routes";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
import styles from "./NewMenu.module.css";
import { PlusIcon } from "../../shared/design-system/icons";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
};

export function NewMenu(props: Props) {
  const connection = useRelayConnection(props.relay);
  return (
    <ReadyNewMenu
      {...props}
      key={connection.scope ?? "disconnected"}
      session={connection.session}
      available={connection.status === "ready" || !!connection.cached}
    />
  );
}

function ReadyNewMenu({
  relay,
  navigator,
  agents,
  session,
  available,
}: Props & { session: RelaySession; available: boolean }) {
  useSyncExternalStore(
    session.soloPreferences.subscribe,
    session.soloPreferences.snapshot,
  );
  const preferences = useSidebarPreferences(session.sidebarPreferences);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const scope = splitPartition(session.scope);
  const current = () => relay.snapshot().session === session;
  return (
    <>
      <MenuRoot>
        <MenuTrigger
          render={
            <IconButton
              hint="familiar"
              ref={trigger}
              disabled={!available}
              aria-label="New"
              title="New"
              variant="chrome"
              shape="round"
              size="sm"
              icon={<PlusIcon className={styles.createIcon} size={18} />}
            />
          }
        />
        <MenuPopup>
          <MenuItem
            onClick={() => {
              if (current())
                void navigator.open(soloDraftTarget(session.scope));
            }}
          >
            New chat
          </MenuItem>
          <MenuItem
            disabled={!session.soloPreferences.sectionCreationWritable}
            onClick={() => {
              if (current()) setCreatingProject(true);
            }}
          >
            New workspace
          </MenuItem>
          <MenuItem
            disabled={!scope}
            onClick={() => {
              if (scope && current())
                void navigator.open({
                  version: 1,
                  kind: "page",
                  pluginId: "buzz.channels",
                  pageId: "channels",
                  scope,
                  route: { version: 1, params: "new-message" },
                });
            }}
          >
            New DM
          </MenuItem>
          <MenuItem
            disabled={!session.channelCreation.available}
            onClick={() => {
              if (current()) setCreatingChannel(true);
            }}
          >
            New channel
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
      <CreateChannelDialog
        open={creatingChannel}
        onOpenChange={setCreatingChannel}
        session={session}
        agents={agents}
        finalFocus={trigger}
        destinations={preferences.data?.sections ?? []}
        initialGroup=""
        groupsReady={preferences.writable}
        onCreate={async (input) => {
          const channelId = await session.channelCreation.create(input);
          revealCreatedChannel(relay, session, navigator, input, channelId);
        }}
      />
      {creatingProject && (
        <NewWorkspace
          session={session}
          create={(section) => session.soloPreferences.createSection(section)}
          close={() => setCreatingProject(false)}
          finalFocus={trigger}
          onCreated={(id) => {
            if (!current()) return;
            resetNewChatProject(session.scope, id);
            void navigator.open(
              soloDraftTarget(session.scope, { project: id }),
            );
          }}
        />
      )}
    </>
  );
}
