import { createContext, type ReactNode } from "react";

/** Optional host-resolved display label; presentation never resolves a destination. */
export const LinkLabelContext = createContext<string | undefined>(undefined);

/** Authored Markdown formatting stays inside the host anchor. */
export const LinkContentContext = createContext<ReactNode>(undefined);

/** Host-resolved visibility for channel links rendered by a shared link renderer. */
export const LinkChannelPrivateContext = createContext(false);

/** Whether the link is live in a message, rather than a composer decoration or
 * preview: a renderer that reads anything for its link does so only then. */
export const LinkInteractiveContext = createContext(true);

/** Host workspace opener for a message link's thread tab; false when it cannot. */
export const LinkThreadTabContext = createContext<
  | ((channelId: string, messageId: string, rootId: string) => boolean)
  | undefined
>(undefined);
