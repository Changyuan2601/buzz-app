/** Source catalogue: defines every message key and is the runtime fallback. */
export const enUS = {
  "settings.title": "Settings",
  "settings.back": "Back",
  "settings.group.app": "App",
  "settings.group.administration": "Administration",
  "settings.group.development": "Development",
  "settings.section.profile": "Profile",
  "settings.section.appearance": "Appearance",
  "settings.section.language": "Language",
  "settings.section.notifications": "Notifications",
  "settings.section.shortcuts": "Shortcuts",
  "settings.section.agents": "Agents",
  "settings.section.plugins": "Plugins",
  "settings.section.updates": "Updates",
  "settings.section.developer": "Developer",
  "language.label": "App language",
  "language.description": "Some parts of Buzz are not translated yet.",
  "language.saveTitle": "Language wasn’t saved",
  "language.saveError":
    "This language is active, but could not be saved on this device. Try again.",
  "language.retry": "Retry saving language",
} as const;

export type MessageKey = keyof typeof enUS;
/** Every shipped locale translates every key, so translated regions never mix in English. */
export type Catalogue = Readonly<Record<MessageKey, string>>;
