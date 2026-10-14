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
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

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

type BuiltIn = Omit<SettingsSection, "label"> & { label: MessageDescriptor };
const profile: BuiltIn = { id: "profile", label: msg`Profile`, icon: UserIcon };
const app: readonly BuiltIn[] = [
  { id: "appearance", label: msg`Appearance`, icon: PaletteIcon },
  { id: "language", label: msg`Language`, icon: GlobeIcon },
  { id: "notifications", label: msg`Notifications`, icon: BellIcon },
  { id: "shortcuts", label: msg`Shortcuts`, icon: KeyboardIcon },
  { id: "agents", label: msg`Agents`, icon: RobotIcon },
  { id: "plugins", label: msg`Plugins`, icon: SquaresFourIcon },
  { id: "updates", label: msg`Updates`, icon: DownloadIcon },
];
const developer: BuiltIn = {
  id: "developer",
  label: msg`Developer`,
  icon: WrenchIcon,
};
const builtIn = new Set<string>(
  [profile, ...app, ...(developerMode ? [developer] : [])].map(({ id }) => id),
);

/** Host-owned sections; any other section is a plugin card contribution key. */
export const isBuiltInSettingsSection = (id: string) => builtIn.has(id);

export function settingsSections(
  cards: readonly Contribution<SettingsCard>[],
  community: Community | undefined,
  i18n: Pick<I18n, "_" | "locale">,
) {
  const lang = i18n.locale;
  const label = (section: BuiltIn): SettingsSection => ({
    ...section,
    label: i18n._(section.label),
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
            label: i18n._(msg`Administration`),
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
      label: i18n._(msg`App`),
      lang,
      sections: [...(community ? [] : [profile]), ...app].map(label),
    },
    ...(developerMode
      ? [
          {
            id: "development",
            label: i18n._(msg`Development`),
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
