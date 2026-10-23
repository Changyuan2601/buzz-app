import { createContext, useContext } from "react";
import type { RelaySession } from "../../features/relay/session";

// Keep context identity outside hot-reloaded component modules. The shell
// retains its sidebar element across page/provider edits during development.
export const BESTIE_PAGE = "buzz.bestie/bestie";
export type BestieMark = {
  label: string;
  searchLabel: "Bestie";
  avatar: { src: string | undefined; shape: "squircle" };
};
export const BestieNavigationContext = createContext<BestieMark | undefined>(
  undefined,
);
export const BestieConversationContext = createContext<
  { session: RelaySession; channelId: string } | undefined
>(undefined);

/** Session-fenced shell placement; unrelated provider edits retain identity. */
export function useBestieConversation(session: RelaySession) {
  const conversation = useContext(BestieConversationContext);
  return conversation?.session === session ? conversation.channelId : undefined;
}
