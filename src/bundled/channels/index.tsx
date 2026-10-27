import { StartLinkedChat, canStartLinkedChat } from "./StartLinkedChat";
import { ChannelCompletion } from "./ChannelCompletion";
import { channelQuery } from "./channel-query";
import { isChannelRoute } from "../../features/channel-navigation/routes";
import type { PluginModule } from "../../plugins/api";
import { ChannelsPage } from "./ChannelsPage";
import { PageTabs } from "./PageTabs";
import { registerCanvas } from "./canvas-panel";
import { ChannelTemplateSettings } from "./ChannelTemplateSettings";
import { ChatCircleIcon, CopyIcon } from "../../shared/design-system/icons";
import { isApplePlatform } from "../../features/shortcuts/format";
import { soloDraftTarget } from "../../features/channel-navigation/routes";
import type { ArchiveShortcut } from "./ChannelsPage";
export const inject = [
  "pages",
  "relay",
  "panels",
  "conversation",
  "navigation",
  "settingsCards",
  "agents",
  "shortcuts",
];
export const apply: PluginModule["apply"] = (ctx) => {
  registerCanvas(ctx);
  ctx.conversation.registerCompletion({
    id: "channel-typeahead",
    title: "Channel",
    match: ({ text, start }) => channelQuery(text, start),
    component: ChannelCompletion,
  });
  const extensions = ctx.conversation;
  extensions.registerTabs((props) => (
    <PageTabs {...props} host={ctx} extensions={extensions} />
  ));
  const relay = ctx.relay;
  const navigator = ctx.navigation;
  ctx.conversation.registerMessageAction({
    id: "start-solo-chat",
    title: "Start Solo chat",
    placement: "menu",
    icon: () => <ChatCircleIcon size={16} aria-hidden="true" />,
    matches: (message, session) =>
      canStartLinkedChat(session, message.channelId) &&
      (!message.delivery || ["accepted", "seen"].includes(message.delivery)),
    component: ({ message, session }) => (
      <StartLinkedChat
        session={session}
        navigation={navigator}
        channelId={message.channelId}
        message={message}
      />
    ),
  });
  const panels = ctx.panels;
  const archive: ArchiveShortcut = {};
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
      if (scope) void navigator.open(soloDraftTarget(scope));
    },
  });
  ctx.shortcuts.register({
    id: "archive-chat",
    title: "Archive chat",
    // Apple Mail's Archive. Elsewhere Ctrl is Mod, and Ctrl+Shift+A is Home.
    binding: isApplePlatform(globalThis.navigator?.platform ?? "")
      ? { key: "a", mod: true, ctrl: true }
      : { key: "e", mod: true, shift: true },
    order: 20,
    allowInEditable: true,
    when: () => !!archive.current?.available(),
    run: () => archive.current?.run(),
  });
  const agents = ctx.agents;
  ctx.settingsCards.register({
    id: "templates",
    title: "Channel templates",
    group: "App",
    icon: CopyIcon,
    component: ({ active }) => (
      <ChannelTemplateSettings agents={agents} active={active} />
    ),
  });
  ctx.pages.register({
    id: "channels",
    title: "Channels",
    primary: true,
    placement: "topbar",
    layout: "workspace",
    companion: true,
    handlesNavigation: true,
    route: { version: 1, validate: isChannelRoute },
    component: ({ companion, navigation }) => (
      <ChannelsPage
        navigation={navigation}
        navigator={navigator}
        extensions={extensions}
        relay={relay}
        panels={panels}
        archive={archive}
        companion={companion}
        agents={agents}
      />
    ),
  });
};
