import { useRelayConnection } from "../features/relay/react";
import { readChannelSidebarWidth } from "../bundled/channels/useSidebarView";
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { Panel } from "../shared/design-system/ui/Panel";
import { ArrowLeftIcon, ChatCircleIcon } from "../shared/design-system/icons";
import channelStyles from "../bundled/channels/Channels.module.css";
import type { Communities } from "../features/communities/service";
import type { SettingsCards } from "../features/settings/service";
import { settingsSections, type SettingsSection } from "./settings-sections";
import styles from "./Settings.module.css";
import { useLocalization } from "../features/localization/service";

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
  const localized = useLocalization();
  const connection = useRelayConnection(communities.relay);
  const width = readChannelSidebarWidth(connection.scope ?? "disconnected");
  const contributed = useSyncExternalStore(cards.subscribe, cards.snapshot);
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const selectedCommunity = client.memberships.find(
    (membership) => membership.id === client.selected,
  );
  const { groups, defaultSection } = useMemo(
    () => settingsSections(contributed, selectedCommunity, localized),
    [contributed, selectedCommunity, localized],
  );
  const current = selected ?? defaultSection;
  const section = ({
    id,
    label,
    lang,
    icon: Icon = ChatCircleIcon,
  }: SettingsSection) => (
    <NavigationItem
      key={id}
      label={label}
      lang={lang}
      icon={<Icon aria-hidden="true" size={18} />}
      selected={current === id}
      aria-current={current === id ? "page" : undefined}
      onClick={() => onSection(id)}
    />
  );

  return (
    <div className="shell-sidebar-default" style={{ width }}>
      <Panel as="aside" aria-label="Settings sidebar">
        <div className={`${channelStyles.sidebar} ${styles.settingsSidebar}`}>
          <NavigationItem
            label={localized.t("settings.back")}
            lang={localized.lang}
            icon={<ArrowLeftIcon aria-hidden="true" size={18} />}
            onClick={onBack}
          />
          <nav
            aria-label="Settings sections"
            className={styles.settingsNavigation}
          >
            {groups.map((group) => (
              <SettingsGroup
                key={group.id}
                label={group.label}
                lang={group.lang}
              >
                {group.sections.map(section)}
              </SettingsGroup>
            ))}
          </nav>
        </div>
      </Panel>
    </div>
  );
}

function SettingsGroup({
  label,
  lang,
  children,
}: {
  label: string;
  lang?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 lang={lang} className={styles.settingsGroupTitle}>
        {label}
      </h2>
      <div className={styles.settingsGroupItems}>{children}</div>
    </section>
  );
}
