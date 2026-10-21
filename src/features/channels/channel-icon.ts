import { GlobeIcon, LockIcon } from "../../shared/design-system/icons/index";

/** Ordinary channel visibility chooses its icon; callers retain non-channel type icons. */
export function channelIcon(
  channel: { readonly private?: true | undefined } | undefined,
) {
  return channel?.private ? LockIcon : GlobeIcon;
}
