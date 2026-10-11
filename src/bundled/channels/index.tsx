import { ChannelCompletion } from "./ChannelCompletion";
import { channelQuery } from "./channel-query";
import { isChannelRoute } from "../../features/channel-navigation/routes";
import type { PluginModule } from "../../plugins/api";
import { ChannelsPage } from "./ChannelsPage";
import { ChannelSetupSettings } from "./ChannelSetupSettings";
import { FolderSimpleIcon } from "../../shared/design-system/icons";
export const inject = [
  "pages",
  "relay",
  "panels",
  "conversation",
  "navigation",
  "settingsCards",
  "agents2",
];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerCompletion({
    id: "channel-typeahead",
    title: "Channel",
    match: ({ text, start }) => channelQuery(text, start),
    component: ChannelCompletion,
  });
  const extensions = ctx.conversation;
  const relay = ctx.relay;
  const panels = ctx.panels;
  const pages = ctx.pages;
  const navigator = ctx.navigation;
  const agents2 = ctx.agents2;
  ctx.settingsCards.register({
    id: "groups",
    title: "Personal groups",
    icon: FolderSimpleIcon,
    component: ({ active }) => (
      <ChannelSetupSettings relay={relay} active={active} />
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
        pages={pages}
        companion={companion}
        agents2={agents2}
      />
    ),
  });
};
