import {
  ChatCircleIcon,
  HashIcon,
  LockIcon,
} from "../../shared/design-system/icons/index";

/** Ordinary channel visibility chooses its icon; callers retain non-channel type icons. */
export function channelIcon(
  channel:
    | {
        readonly private?: true | undefined;
        readonly channelType?: string | undefined;
      }
    | undefined,
) {
  if (channel?.channelType === "solo") return ChatCircleIcon;
  return channel?.private ? LockIcon : HashIcon;
}
