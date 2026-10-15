import { useRelayConnection } from "../features/relay/react";
import { ResizableSidebar } from "../features/channel-navigation/ResizableSidebar";
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { Panel } from "../shared/design-system/ui/Panel";
import { ArrowLeftIcon, ChatCircleIcon } from "../shared/design-system/icons";
import channelStyles from "../bundled/channels/Channels.module.css";
import type { Communities } from "../features/communities/service";
import type { SettingsCards } from "../features/settings/service";
import { settingsSections, type SettingsSection } from "./settings-sections";
import styles from "./Settings.module.css";

export function SettingsSidebar({
  cards,
  communities,
  selected,
  onBack,
  onSection,
}: {
  cards: SettingsCards;
  communities: Communities;
  selected?: string;
  onBack: () => void;
  onSection: (section: string) => void;
}) {
  const connection = useRelayConnection(communities.relay);
  const scope = connection.scope ?? "disconnected";
  const contributed = useSyncExternalStore(cards.subscribe, cards.snapshot);
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const selectedCommunity = client.memberships.find(
    (membership) => membership.id === client.selected,
  );
  const { groups, defaultSection } = useMemo(
    () => settingsSections(contributed, selectedCommunity),
    [contributed, selectedCommunity],
  );
  const current = selected ?? defaultSection;
  const section = ({
    id,
    label,
    icon: Icon = ChatCircleIcon,
  }: SettingsSection) => (
    <NavigationItem
      key={id}
      label={label}
      icon={<Icon aria-hidden="true" size={18} />}
      selected={current === id}
      aria-current={current === id ? "page" : undefined}
      onClick={() => onSection(id)}
    />
  );

  return (
    <ResizableSidebar scope={scope}>
      <Panel as="aside" aria-label="Settings sidebar">
        <div className={`${channelStyles.sidebar} ${styles.settingsSidebar}`}>
          <NavigationItem
            label="Back"
            icon={<ArrowLeftIcon aria-hidden="true" size={18} />}
            onClick={onBack}
          />
          <nav
            aria-label="Settings sections"
            className={styles.settingsNavigation}
          >
            {groups.map((group) => (
              <SettingsGroup key={group.id} label={group.label}>
                {group.sections.map(section)}
              </SettingsGroup>
            ))}
          </nav>
        </div>
      </Panel>
    </ResizableSidebar>
  );
}

function SettingsGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className={styles.settingsGroupTitle}>{label}</h2>
      <div className={styles.settingsGroupItems}>{children}</div>
    </section>
  );
}
