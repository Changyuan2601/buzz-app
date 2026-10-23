// The agent's connection to its community on a standalone host: the app's own
// relay session (`createRelaySession`), signed in as the agent. It hears the
// agent's channels live, keeps their rosters and labels, and answers the
// agent's reads, as the owner's session does in the app. It is read-only: the
// agent publishes only through the host's custody, which checks each kind.
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { finalizeEvent } from "nostr-tools/pure";
import type { NodeClient } from "../buzz-mcp/node";
import { communityDestination } from "../features/communities/destination";
import { audienceAuthorityCommunity } from "../features/sessions/audience-authority";
import {
  createRelaySession,
  type RelaySession,
} from "../features/relay/session";
import type { RelayData } from "../features/relay/service";
import {
  connectSignedTransport,
  type ReadTransport,
  type Signer,
} from "../features/relay/transport";

export type AgentSession = Readonly<{
  session: RelaySession;
  /** The session as the app's relay service gives it, always ready. */
  relay: RelayData;
}>;

/** The community's NIP-11 information. */
export async function relayInfo(relay: string, signal?: AbortSignal) {
  const response = await fetch(relay.replace(/^ws/, "http"), {
    headers: { accept: "application/nostr+json" },
    signal: signal ?? null,
  });
  if (!response.ok)
    throw new Error(`Community information: ${response.status}`);
  const info = (await response.json()) as Record<string, unknown> | null;
  if (!info || typeof info !== "object")
    throw new Error("Invalid community information");
  return info;
}

/** Connects as the agent. `scope` partitions what the app keeps for it. */
export async function connectAgentSession(
  options: Readonly<{
    relay: string;
    secret: Uint8Array;
    pubkey: string;
    /** The owner's NIP-OA `auth` tag, which the agent's login carries. */
    auth?: readonly string[];
    client: NodeClient;
    scope: string;
  }>,
): Promise<AgentSession> {
  const { secret, pubkey, auth, client, scope } = options;
  const origin = communityDestination(options.relay).url;
  const info = await relayInfo(origin);
  // As the app reads it (`connectNativeTransport`).
  const author = info.self;
  if (typeof author !== "string" || !/^[a-f0-9]{64}$/.test(author))
    throw new Error("The community did not give its identity");
  const extensions = Array.isArray(info.supported_extensions)
    ? info.supported_extensions
    : [];
  const signer: Signer = {
    getPublicKey: async () => pubkey,
    signEvent: async (template: EventTemplate) =>
      finalizeEvent(
        {
          ...template,
          tags:
            template.kind === 22242 && auth
              ? [...template.tags, [...auth]]
              : template.tags,
        },
        secret,
      ) as VerifiedEvent,
    request: (url, body, signal) => client.signedRequest(url, body, signal),
  };
  // Nothing the session does publishes as the agent: it has no writer, and
  // its live connection sends only the login and its subscriptions.
  const {
    writer: _writer,
    subscribe,
    ...signed
  } = await connectSignedTransport(signer, origin, author);
  const transport: ReadTransport = {
    ...signed,
    ...(subscribe
      ? {
          subscribe: (callbacks) => {
            const {
              publish: _publish,
              publishPresence: _presence,
              publishTyping: _typing,
              ...traffic
            } = subscribe(callbacks);
            return traffic;
          },
        }
      : {}),
    archiveAuthority: author,
    ...(extensions.includes("nip-cl")
      ? { channelIdentity: true as const }
      : {}),
    ...(audienceAuthorityCommunity(info.audience_authority)
      ? {
          audienceAuthorityCommunity: audienceAuthorityCommunity(
            info.audience_authority,
          ),
        }
      : {}),
  };
  const store = createRelaySession(transport, { warm: false });
  await store.restore();
  const { session } = store;
  const snapshot = Object.freeze({
    status: "ready" as const,
    generation: 1,
    scope,
    origin,
    session,
    viewer: pubkey,
  });
  return Object.freeze({
    session,
    relay: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      retry: () => session.live.retry(),
      disconnect: () => store.dispose(),
      clearCache: async () => {},
    },
  });
}
