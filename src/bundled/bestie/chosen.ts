import {
  readDefaultAgent,
  setDefaultAgent,
  useChosenAgent,
} from "../../features/solo/default-agent";

/**
 * The main agent is the agent already chosen as this device's default for the
 * account and community: one stored value, named two ways. Choosing one here
 * and making one the default agent in Agents are the same act, so the two
 * surfaces can never disagree about which agent it is.
 */
export const readBestie = readDefaultAgent;

/** Choosing a main agent is choosing the agent new chats are addressed to. A key
 * that is not one refuses rather than clearing the main agent in place, since
 * `setDefaultAgent` treats an unusable key as "no default". False means the
 * choice was not saved on this device. */
export function chooseBestie(scope: string, pubkey: string) {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return false;
  return setDefaultAgent(scope, pubkey);
}

/** The saved main agent, initialized by default selection or chosen by the person.
 * Identity stays exact: namesakes are different agents. */
export const useBestie = useChosenAgent;
