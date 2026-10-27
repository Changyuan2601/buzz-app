import type { AgentChoicesSnapshot } from "../../features/agents/choices";
import type {
  ChannelList,
  ChannelSummary,
} from "../../features/relay/contracts";
import { formatPublicKey } from "../../shared/identity/public-key";
import { bestieChat } from "./chat";

export type BestieAgent = AgentChoicesSnapshot["selectable"][number];

/** What the page shows. Evidence decides: a roster that is still loading or
 * failed is never presented as having no agents, and a chat list that is not
 * ready is never presented as having no chat. */
export type BestieState =
  | { kind: "loading" }
  | { kind: "unavailable"; source: "agents" | "chats"; error?: string }
  /** No Bestie yet, or the chosen one can no longer be reached. */
  | {
      kind: "choose";
      agents: readonly BestieAgent[];
      missing?: string;
      /** Some agents could not be read: this list may be incomplete. */
      partial?: string;
    }
  /** Chosen, with no verified DM yet: open through the shared DM owner. */
  | { kind: "start"; bestie: BestieAgent; agents: readonly BestieAgent[] }
  | {
      kind: "chat";
      bestie: BestieAgent;
      agents: readonly BestieAgent[];
      channel: ChannelSummary;
    };

/** The agent's own name, as the rest of Buzz addresses it. */
export const bestieName = (agent: BestieAgent) =>
  agent.managedName ?? agent.name;

export function bestieState({
  chosen,
  choices,
  channels,
  viewer,
}: {
  chosen: string | undefined;
  choices: AgentChoicesSnapshot;
  channels: ChannelList;
  viewer: string | undefined;
}): BestieState {
  const agents = choices.selectable;
  const bestie = chosen
    ? agents.find((agent) => agent.pubkey === chosen)
    : undefined;
  if (!bestie) {
    // A read that failed, and a host with no agent source at all, both leave
    // evidence that will never complete on its own. One source failing while
    // another succeeds stays `ready` and reports its error alongside the agents
    // it did return, so an error is evidence of failure whatever the status.
    const failed =
      choices.status === "error" ||
      choices.status === "unavailable" ||
      !!choices.error;
    // An explicit choice is honored as soon as its agent is present, so only
    // its absence waits for complete evidence. A failed read that still
    // produced agents offers them, and says the list may be short.
    if (!settled(choices) && !(failed && agents.length))
      return failed
        ? { kind: "unavailable", source: "agents", ...error(choices.error) }
        : { kind: "loading" };
    return {
      kind: "choose",
      agents,
      ...(chosen ? { missing: formerName(choices, chosen) } : {}),
      ...(failed
        ? { partial: choices.error ?? "Some agents couldn’t be read." }
        : {}),
    };
  }
  const channel = bestieChat(channels.channels, viewer, bestie.pubkey);
  if (channel) return { kind: "chat", bestie, agents, channel };
  // Starting a second chat because the first could not be read would strand
  // the conversation this page is for.
  if (channels.status === "error" || channels.status === "unavailable")
    return { kind: "unavailable", source: "chats", ...error(channels.error) };
  if (channels.status !== "ready") return { kind: "loading" };
  return { kind: "start", bestie, agents };
}

const settled = (choices: AgentChoicesSnapshot) =>
  choices.complete &&
  choices.archives.status !== "idle" &&
  choices.archives.status !== "loading";

const error = (message: string | undefined) =>
  message ? { error: message } : {};

/** A chosen agent that is gone is still named, so the person knows which one
 * left rather than reading a bare key. */
function formerName(choices: AgentChoicesSnapshot, chosen: string) {
  const known = choices.identities.find((agent) => agent.pubkey === chosen);
  return (known ? bestieName(known) : formatPublicKey(chosen)) ?? "That agent";
}
