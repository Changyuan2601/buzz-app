import type { PluginModule } from "../../plugins/api";
import { isApplePlatform } from "../../features/shortcuts/format";
import { SessionsPage } from "../sessions/SessionsPage";
import { isMeRoute, meTarget } from "./routes";

export const inject = [
  "pages",
  "relay",
  "conversation",
  "navigation",
  "panels",
  "shortcuts",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const extensions = ctx.conversation;
  const navigator = ctx.navigation;
  ctx.shortcuts.register({
    id: "new-conversation",
    title: "New conversation",
    binding: { key: "n", mod: true },
    order: 10,
    allowInEditable: true,
    // Off Apple platforms, Ctrl+N is shell history in the terminal.
    when: () =>
      !!relay.snapshot().scope &&
      (isApplePlatform(window.navigator.platform) ||
        !document.activeElement?.closest(".xterm")),
    run: () => {
      const { scope } = relay.snapshot();
      if (scope) void navigator.open(meTarget(scope));
    },
  });
  ctx.pages.register({
    id: "me",
    title: "Solo",
    primary: true,
    placement: "topbar",
    layout: "workspace",
    companion: true,
    route: { version: 1, validate: isMeRoute },
    component: ({ navigation, companion }) => (
      <div className="flex h-full min-h-0 flex-col">
        <SessionsPage
          relay={relay}
          panels={ctx.panels}
          companion={companion}
          extensions={extensions}
          navigator={navigator}
          navigation={navigation}
        />
      </div>
    ),
  });
};
