import type { PluginModule } from "../../plugins/api";
import { MessagesInventory } from "./MessagesInventory";
export const inject = [
  "messagesNav",
  "relay",
  "navigation",
  "agents",
  "conversation",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const navigator = ctx.navigation;
  const agents = ctx.agents;
  const chatIcons = ctx.conversation.chatIcons;
  ctx.messagesNav.register({
    id: "messages",
    title: "Messages",
    order: -100,
    component: ({ target }) => (
      <MessagesInventory
        relay={relay}
        navigator={navigator}
        agents={agents}
        chatIcons={chatIcons}
        target={target}
      />
    ),
  });
};
