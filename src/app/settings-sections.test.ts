// @vitest-environment jsdom
import { expect, it } from "vitest";
import type { SettingsCard } from "../features/settings/service";
import type { Contribution } from "../plugins/contributions";
import {
  developerMode,
  isBuiltInSettingsSection,
  settingsSections,
} from "./settings-sections";

const card = (
  key: string,
  extra: Partial<SettingsCard> = {},
): Contribution<SettingsCard> => {
  const [pluginId = "", id = ""] = key.split("/");
  return {
    id,
    key,
    pluginId,
    revision: "one",
    title: key,
    component: () => null,
    ...extra,
  };
};
const cards = [
  // Plugin activation/re-enable order must not determine community navigation.
  card("buzz.pairing/mobile", { personal: true }),
  card("buzz.emoji/custom-emoji"),
  card("buzz.channels/templates", { group: "App" }),
  card("example/groups"),
  card("other/groups"),
  card("example/membership", { section: "administration" }),
  card("example/hosted", { group: "Communities" }),
  card("buzz.agents/jev-classifier", {
    group: "Plugins",
    title: "Jev classifier",
  }),
  card("block.hosted-communities/hosted", {
    group: "Plugins",
    title: "Builderlab hosting",
  }),
  card("block.builderlab/login", {
    group: "Plugins",
    title: "Builderlab agents",
  }),
];
const primary = { id: "primary", name: "Primary" };
const app = [
  "identity",
  "appearance",
  "notifications",
  "shortcuts",
  "agents",
  "buzz.channels/templates",
  "updates",
  ...(developerMode ? ["developer"] : []),
];
const plugins = [
  "plugins",
  "block.builderlab/login",
  "block.hosted-communities/hosted",
  "buzz.agents/jev-classifier",
];
const outline = (model: ReturnType<typeof settingsSections>) =>
  model.groups.map((group) => [
    group.id,
    group.label,
    group.sections.map((section) => section.id),
  ]);

it.each([
  [
    "a selected community",
    primary,
    "profile",
    [
      [
        "community",
        "Primary",
        [
          "profile",
          "buzz.emoji/custom-emoji",
          "example/groups",
          "other/groups",
          "local-archive",
          "buzz.pairing/mobile",
          "leave-community",
        ],
      ],
      ["administration", "Community admin", ["example/membership"]],
      ["app", "Buzz", app],
      ["plugins", "Plugins", plugins],
      ["group:Communities", "Communities", ["example/hosted"]],
    ],
  ],
  [
    "Personal",
    undefined,
    "appearance",
    [
      ["personal", "Personal space", ["profile", "buzz.pairing/mobile"]],
      ["app", "Buzz", app],
      ["plugins", "Plugins", plugins],
      ["group:Communities", "Communities", ["example/hosted"]],
    ],
  ],
])(
  "orders Settings groups and defaults for %s",
  (_, community, initial, groups) => {
    const model = settingsSections(cards, community);
    expect(outline(model)).toEqual(groups);
    expect(model.defaultSection).toBe(initial);
    expect(model.sections.map((section) => section.id)).toEqual(
      groups.flatMap(([, , ids]) => ids),
    );
  },
);

it("classifies built-in sections apart from plugin card keys", () => {
  for (const id of [
    "profile",
    "identity",
    "plugins",
    "local-archive",
    "leave-community",
    ...app.filter((id) => id !== "buzz.channels/templates"),
  ])
    expect(isBuiltInSettingsSection(id)).toBe(true);
  expect(isBuiltInSettingsSection("developer")).toBe(developerMode);
  for (const id of [
    "example/groups",
    "buzz.channels/templates",
    "Profile",
    "",
    "administration",
  ])
    expect(isBuiltInSettingsSection(id)).toBe(false);
});
