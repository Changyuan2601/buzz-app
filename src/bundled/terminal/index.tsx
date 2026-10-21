import { useLayoutEffect } from "react";
import type { PluginModule } from "../../plugins/api";
import type { ChannelLauncherProps } from "../../features/panels/service";
import { nativeBridge } from "./bridge";
import { createSessions } from "./sessions";
import { TerminalPanel } from "./TerminalPanel";

export const inject = ["panels", "shortcuts", "relay"];
const TOGGLE_BINDING = { key: "j", mod: true } as const;
export const apply: PluginModule["apply"] = (ctx) => {
  // No unusable launcher or reserved shortcut in a browser-only host.
  if (!nativeBridge.available) return;
  const sessions = createSessions(
    nativeBridge,
    async () => (await import("./renderer")).createScreen,
    ctx.relay.snapshot,
  );
  let binding: { toggle(): void; available(): boolean } | undefined;
  ctx.effect(() => () => {
    binding = undefined;
    return sessions.dispose();
  });
  ctx.shortcuts.register({
    id: "toggle",
    title: "Toggle channel terminal",
    binding: TOGGLE_BINDING,
    // Plugin Settings order: the terminal action is the category's primary action.
    order: 10,
    allowInEditable: true,
    when: () => !!binding?.available(),
    run: () => binding?.toggle(),
  });
  function Launcher({ context, toggle, available }: ChannelLauncherProps) {
    const target = JSON.stringify(context);
    useLayoutEffect(() => {
      const current = { toggle: () => toggle(target), available };
      binding = current;
      return () => {
        if (binding === current) binding = undefined;
      };
    }, [toggle, target, available]);
    // Keep the keyboard binding alive while the host overflow is closed.
    return null;
  }
  ctx.panels.register({
    id: "terminal",
    title: "Terminal",
    matches: () => false,
    channelLauncher: Launcher,
    component: (props) => <TerminalPanel {...props} sessions={sessions} />,
  });
};
