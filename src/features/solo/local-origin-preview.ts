import type { ChannelSummary } from "../relay/contracts";
import {
  parseChannelOrigin,
  type ChannelOrigin,
} from "../relay/channel-origin";
import { readView, writeView } from "../../shared/view-state";

/** UX preview only. Vite forces this off for every build, including development builds. */
export const localOriginPreview = () =>
  import.meta.env.DEV && import.meta.env.VITE_BUZZ_LOCAL_ORIGIN_PREVIEW === "1";

const key = (id: string) => `dev:solo-origin:${id}`;

/** Save before creating anything: failed local persistence must preserve the draft. */
export function saveLocalOrigin(
  scope: string,
  id: string,
  origin: ChannelOrigin,
) {
  if (!localOriginPreview())
    throw new Error("Local source preview is disabled.");
  const value = parseChannelOrigin(origin);
  if (!value || !writeView(scope, key(id), value))
    throw new Error(
      "The source couldn’t be saved on this device. Your draft is kept; retry to start the chat.",
    );
}

/** Never alter the relay snapshot or grant authority. Only this owner's readable chat uses the fallback. */
export function chatOrigin(
  scope: string,
  viewer: string | undefined,
  channel: ChannelSummary | undefined,
): ChannelOrigin | undefined {
  if (channel?.origin) return channel.origin;
  if (
    !localOriginPreview() ||
    !channel ||
    !viewer ||
    channel.creator !== viewer ||
    channel.cached ||
    channel.readOnly
  )
    return undefined;
  return parseChannelOrigin(readView<unknown>(scope, key(channel.id), null));
}
