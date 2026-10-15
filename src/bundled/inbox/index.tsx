import type { PluginModule } from "../../plugins/api";
import { isApplePlatform } from "../../features/shortcuts/format";
import { InboxPage, type ArchiveShortcut } from "./InboxPage";
export const inject = [
  "pages",
  "relay",
  "navigation",
  "conversation",
  "shortcuts",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const navigator = ctx.navigation;
  const archive: ArchiveShortcut = {};
  ctx.shortcuts.register({
    id: "archive-conversation",
    title: "Archive or restore conversation",
    // Me's Archive chat chord: Apple Mail's Archive, and Ctrl+Shift+E elsewhere.
    binding: isApplePlatform(globalThis.navigator?.platform ?? "")
      ? { key: "a", mod: true, ctrl: true }
      : { key: "e", mod: true, shift: true },
    order: 10,
    allowInEditable: true,
    when: () => !!archive.current,
    run: () => archive.current?.(),
  });
  ctx.pages.register({
    id: "inbox",
    title: "Inbox",
    layout: "workspace",
    primary: true,
    component: () => (
      <InboxPage
        relay={relay}
        navigator={navigator}
        extensions={ctx.conversation}
        archive={archive}
      />
    ),
  });
};
