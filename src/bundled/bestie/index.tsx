import type { PluginModule } from "../../plugins/api";
import { BestiePage } from "./page";

export const inject = [
  "pages",
  "relay",
  "navigation",
  "panels",
  "conversation",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const extensions = ctx.conversation;
  ctx.pages.register({
    id: "bestie",
    title: "Bestie",
    layout: "workspace",
    primary: true,
    component: () => (
      <BestiePage host={ctx} relay={relay} extensions={extensions} />
    ),
  });
};
