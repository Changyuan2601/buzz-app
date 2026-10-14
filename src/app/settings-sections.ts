// One Settings section policy for the standalone and shell presentations and
// route classification. Visibility and authorization stay with settingsCards.
import {
  BellIcon,
  ChatCircleIcon,
  DownloadIcon,
  GlobeIcon,
  KeyboardIcon,
  PaletteIcon,
  RobotIcon,
  SquaresFourIcon,
  UserIcon,
  UsersIcon,
  WrenchIcon,
} from "../shared/design-system/icons/index";
import type { SettingsCard } from "../features/settings/service";
import type { Contribution } from "../plugins/contributions";
import type { Localized } from "../features/localization/service";

type Community = { name: string };
export type SettingsSection = {
  id: string;
  label: string;
  /** Contributed groups leave the icon to each presentation. */
  icon?: typeof UserIcon;
  /** Set on host-translated labels; contributed labels keep inherited metadata. */
  lang?: string;
};
export type SettingsGroup = {
  id: string;
  label: string;
  lang?: string;
  sections: readonly SettingsSection[];
};

// DEV alone is not enough: packaged desktop builds load a production bundle
// from tauri://localhost, so the hostname check excludes them too.
export const developerMode =
  import.meta.env.DEV &&
  /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);

type BuiltIn = Omit<SettingsSection, "label"> & {
  id:
    | "profile"
    | "appearance"
    | "notifications"
    | "shortcuts"
    | "agents"
    | "plugins"
    | "language"
    | "updates"
    | "developer";
};
const profile: BuiltIn = { id: "profile", icon: UserIcon };
const app: readonly BuiltIn[] = [
  { id: "appearance", icon: PaletteIcon },
  { id: "language", icon: GlobeIcon },
  { id: "notifications", icon: BellIcon },
  { id: "shortcuts", icon: KeyboardIcon },
  { id: "agents", icon: RobotIcon },
  { id: "plugins", icon: SquaresFourIcon },
  { id: "updates", icon: DownloadIcon },
];
const developer: BuiltIn = { id: "developer", icon: WrenchIcon };
const builtIn = new Set<string>(
  [profile, ...app, ...(developerMode ? [developer] : [])].map(({ id }) => id),
);

/** Host-owned sections; any other section is a plugin card contribution key. */
export const isBuiltInSettingsSection = (id: string) => builtIn.has(id);

export function settingsSections(
  cards: readonly Contribution<SettingsCard>[],
  community: Community | undefined,
  { t, lang }: Localized,
) {
  const label = (section: BuiltIn): SettingsSection => ({
    ...section,
    label: t(`settings.section.${section.id}`),
    lang,
  });
  const section = (
    card: Contribution<SettingsCard>,
    icon?: typeof UserIcon,
  ): SettingsSection => {
    const resolvedIcon = card.icon ?? icon;
    return {
      id: card.key,
      label: card.title,
      ...(resolvedIcon ? { icon: resolvedIcon } : {}),
    };
  };
  const administration = community
    ? cards
        .filter((card) => card.section === "administration")
        .map((card) => section(card, UsersIcon))
    : [];
  const groups: SettingsGroup[] = [
    ...(community
      ? [
          {
            id: "community",
            label: community.name,
            sections: [
              label(profile),
              ...cards
                .filter((card) => !card.group && !card.section)
                .map((card) => section(card, ChatCircleIcon)),
            ],
          },
        ]
      : []),
    ...(administration.length > 0
      ? [
          {
            id: "administration",
            label: t("settings.group.administration"),
            lang,
            sections: administration,
          },
        ]
      : []),
    ...[...new Set(cards.flatMap((card) => card.group ?? []))].map((label) => ({
      id: `group:${label}`,
      label,
      sections: cards
        .filter((card) => card.group === label)
        .map((card) => section(card)),
    })),
    {
      id: "app",
      label: t("settings.group.app"),
      lang,
      sections: [...(community ? [] : [profile]), ...app].map(label),
    },
    ...(developerMode
      ? [
          {
            id: "development",
            label: t("settings.group.development"),
            lang,
            sections: [label(developer)],
          },
        ]
      : []),
  ];
  return {
    groups,
    sections: groups.flatMap((group) => group.sections),
    defaultSection: community ? "profile" : "appearance",
  };
}
