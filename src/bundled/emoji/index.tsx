import { EmojiCompletion } from "./EmojiCompletion";
import { emojiQuery } from "./emoji-query";
import type { PluginModule } from "../../plugins/api";
import type {
  ComposerToolProps,
  InlineContent,
} from "../../features/conversation/contracts";
import { emojiMatches } from "../../features/relay/emoji";
import { createReactionPicker } from "./ReactionPicker";
import { EmojiPicker } from "./EmojiPicker";
import { CustomEmoji } from "./CustomEmoji";
import { copyEmoji } from "./copy-emoji";
import {
  loadStandardEmoji,
  mayHaveShortcode,
  standardMatches,
  type StandardEmoji,
} from "./standard-emoji";
import { CustomEmojiSettings } from "./CustomEmojiSettings";
import { SmileyIcon } from "../../shared/design-system/icons";

export const inject = ["conversation"];
const entries = (content: InlineContent) =>
  content.reaction
    ? content.reaction.emoji
      ? [content.reaction.emoji]
      : []
    : (content.message.emoji ?? []);
export const apply: PluginModule["apply"] = (ctx) => {
  // Authoring needs a relay host; conversation-only hosts still get the palette.
  ctx.inject(["relay", "settingsCards"], (scope) => {
    const relay = scope.relay;
    scope.settingsCards.register({
      id: "custom-emoji",
      title: "Custom emoji",
      icon: SmileyIcon,
      component: ({ active }) => (
        <CustomEmojiSettings relay={relay} active={active} />
      ),
    });
  });
  ctx.effect(() => {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("copy", copyEmoji);
    return () => document.removeEventListener("copy", copyEmoji);
  });
  ctx.conversation.registerCompletion({
    id: "typeahead",
    title: "Emoji",
    order: 0,
    match: (observation) => emojiQuery(observation.text, observation.start),
    component: EmojiCompletion,
  });
  ctx.conversation.registerTool({
    id: "picker",
    title: "Emoji",
    reactionComponent: createReactionPicker(),
    component: ({
      session,
      scope,
      disabled,
      insertText,
    }: ComposerToolProps) => (
      <EmojiPicker
        session={session}
        scope={scope}
        disabled={disabled}
        insert={insertText}
      />
    ),
  });
  ctx.conversation.registerInline({
    id: "custom",
    title: "Custom emoji",
    matches: (content) => [...emojiMatches(content.text, entries(content))],
    component: ({ text, content, media }) => {
      const emoji = entries(content).find(
        (entry) => `:${entry.shortcode}:` === text.toLowerCase(),
      );
      return emoji ? <CustomEmoji emoji={emoji} media={media} /> : text;
    },
  });
  // Standard shortcodes such as `:+1:` show as their emoji. The dataset loads
  // the first time a message may hold one; registering the renderer then
  // draws the messages again. Custom emoji, registered first, win a shared
  // shortcode.
  let active = true;
  ctx.effect(() => () => {
    active = false;
  });
  let standard: StandardEmoji | undefined;
  const registerStandard = (emoji: StandardEmoji) => {
    if (!active || standard) return;
    standard = emoji;
    ctx.conversation.registerInline({
      id: "standard",
      title: "Emoji shortcodes",
      matches: (content) => standardMatches(content.text, emoji),
      component: ({ text }) =>
        emoji.get(text.slice(1, -1).toLowerCase()) ?? text,
    });
  };
  ctx.conversation.registerInline({
    id: "standard-loader",
    title: "Emoji shortcodes",
    matches: (content) => {
      if (!standard && mayHaveShortcode(content.text))
        void loadStandardEmoji().then(registerStandard, () => {
          /* Shortcodes stay as text; a later message tries again. */
        });
      return [];
    },
    component: ({ text }) => text,
  });
};
