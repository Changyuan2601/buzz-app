import { Context } from "@deepseek-ai/cordis";
import type { EventTemplate } from "nostr-tools";
import { vi, type Mock } from "vitest";
import {
  AgentsService,
  type AgentCommunities,
} from "../../features/agents/service";
import type { ClientSnapshot } from "../../features/communities/service";
import { HostService } from "../../features/host/service";
import type { Navigation } from "../../features/navigation/controller";
import { ConversationService } from "../../features/conversation/service";
import { PagesService } from "../../features/pages/service";
import { PanelsService } from "../../features/panels/service";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import type { OutgoingEvent } from "../../features/relay/outbox";
import { relayPartition } from "../../features/relay/partition";
import { matchesEvent } from "../../features/relay/projection";
import type { RelaySnapshot } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  metadata,
  roster,
  signed,
} from "../../features/relay/testing";
import { SettingsCardsService } from "../../features/settings/service";
import { PluginRuntime } from "../../plugins/runtime";
import type { PluginInfo } from "../../plugins/types";
import * as builderlab from "../builderlab/index";
import builderlabManifest from "../builderlab/manifest.json";
import { deferred } from "../builderlab/test-helpers";
import * as bestiePlugin from "./index";
import bestieManifest from "./manifest.json";
import { createRemoteBestie } from "./setup";

export const COMMUNITY = "https://community.example";
export const HOME = "11111111-1111-4111-8111-111111111111";
export const cleanups: (() => Promise<void> | void)[] = [];

type Row = {
  key: string;
  agent_id: string;
  agent_name: string;
  agent_pubkey: string;
  status: number;
  agent_instructions?: string;
  /** `1` for a hosted Bestie; absent for a plain agent. */
  agent_type?: number;
};
type Reply = { status: number; body: unknown };

/** Real Builderlab and Bestie plugins, Agents service, relay session and
 * Outbox. Only the native bridge (Beekeeper HTTP, login, owner signing) and the
 * relay wire are simulated. `invoke` is the test file's mocked Tauri invoke. */
export async function bestieFixture(invoke: Mock) {
  const identity = keypair();
  const authority = keypair();
  const remote = keypair();
  const rows: Row[] = [];
  /** Per-endpoint one-shot replies, such as a refused account. */
  const replies = new Map<string, Reply>();
  const holds = new Map<string, Promise<void>>();
  let signInCanceled = false;
  invoke.mockImplementation(
    async (command: string, input: Record<string, unknown>) => {
      if (command === "oauth_callback_begin")
        return {
          id: "attempt",
          callbackUrl: `http://127.0.0.1:12345${input.callbackPath}`,
        };
      if (command === "oauth_callback_wait") {
        if (signInCanceled) {
          signInCanceled = false;
          throw new Error("Sign-in canceled.");
        }
        return { parameters: [["code", "one-time"]] };
      }
      if (command === "oauth_callback_cancel") return;
      if (command === "identity_restore") return identity.pubkey;
      if (command === "identity_prepare_remote_agent_authorization")
        return ["auth", identity.pubkey, "", "ef".repeat(64)];
      if (command !== "plugin_host_request")
        throw new Error(`Unexpected command ${command}`);
      const { request } = input as { request: { url: string; body: string } };
      const path = new URL(request.url).pathname.split("/").at(-1) ?? "";
      const body = JSON.parse(request.body || "{}");
      const hold = holds.get(path);
      holds.delete(path);
      if (hold) await hold;
      const reply = replies.get(path);
      replies.delete(path);
      if (reply)
        return {
          status: reply.status,
          headers: {},
          body: JSON.stringify(reply.body),
        };
      let result: unknown;
      if (path === "exchange") result = { session_credential: "token" };
      else if (path === "me")
        result = {
          subject: "owner",
          email: "owner@example.com",
          capabilities: { can_use_remote_agents: true },
        };
      // The owner's key is already linked, so setup skips binding it.
      else if (path === "current")
        result = { identity: { pubkey_hex: identity.pubkey } };
      else if (path === "list-agents") result = { status: 1, agents: rows };
      else if (path === "register-agent") {
        // Beekeeper replays a registration by its idempotency key.
        let row = rows.find((item) => item.key === body.idempotency_key);
        if (
          !row &&
          body.agent_type === "AGENT_TYPE_BESTIE" &&
          rows.some((item) => item.agent_type === 1 && item.status !== 3)
        ) {
          // Beekeeper allows only one live (unattested or active) Bestie.
          result = { status: 6 };
        } else {
          if (!row) {
            row = {
              key: body.idempotency_key,
              agent_id: `id-${rows.length}`,
              agent_name: body.agent_name,
              agent_pubkey: rows.length ? keypair().pubkey : remote.pubkey,
              status: 1,
              ...(body.agent_type === "AGENT_TYPE_BESTIE"
                ? { agent_type: 1 }
                : {}),
            };
            rows.push(row);
          }
          result = {
            status: 1,
            agent_id: row.agent_id,
            agent_pubkey: row.agent_pubkey,
          };
        }
      } else if (path === "attest-agent") {
        const row = rows.find(
          (item) => item.agent_pubkey === body.agent_pubkey,
        );
        if (!row) throw new Error("No registered agent");
        row.status = 2;
        result = { status: 1 };
      } else if (path === "update-agent") {
        const row = rows.find(
          (item) => item.agent_pubkey === body.agent_pubkey,
        );
        if (row) row.agent_instructions = body.agent_instructions;
        result = {};
      } else if (path === "enable-bestie") {
        // Beekeeper signs check-in as the agent; the relay holds it.
        result = rows.some((item) => item.agent_id === body.agent_id)
          ? { status: "succeeded", workflow_id: crypto.randomUUID() }
          : {
              status: "failed",
              error_code: "unauthorized",
              error_message: "No active Buzz agent",
            };
      } else if (path === "disable-bestie") {
        result = rows.some((item) => item.agent_id === body.agent_id)
          ? { status: "succeeded" }
          : {
              status: "failed",
              error_code: "unauthorized",
              error_message: "No active Buzz agent",
            };
      } else throw new Error(`Unexpected Builderlab endpoint: ${path}`);
      return { status: 200, headers: {}, body: JSON.stringify(result) };
    },
  );

  // Relay wire: channel commands become relay-signed metadata and rosters.
  const channels = new Map<
    string,
    { members: string[]; visibility: "open" | "private" }
  >();
  let clock = 1_700_000_000;
  let failKind: number | undefined;
  const events: RelayEvent[] = [];
  let saved: readonly OutgoingEvent[] = [];
  let closed = deferred<void>();
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    [
      ...events,
      ...[...channels].flatMap(([id, home]) => [
        metadata(authority, id, "Bestie", clock, [
          [home.visibility === "private" ? "private" : "public"],
          ["t", "stream"],
        ]),
        roster(authority, id, home.members, clock),
        signed(authority, {
          kind: 39001,
          created_at: clock,
          content: "",
          tags: [
            ["d", id],
            ["p", identity.pubkey, "admin"],
          ],
        }),
      ]),
    ].filter((event) => filters.some((filter) => matchesEvent(event, filter))),
  );
  const sign = vi.fn(async (event: EventTemplate) => signed(identity, event));
  const publish = vi.fn(async (event: RelayEvent) => {
    if (failKind === event.kind) {
      failKind = undefined;
      throw new Error("Receipt lost");
    }
    events.push(event);
    const tag = (name: string) =>
      event.tags.find(([key]) => key === name)?.[1] ?? "";
    if (event.kind === 9007)
      channels.set(tag("h"), {
        members: [identity.pubkey],
        visibility: tag("visibility") as "open" | "private",
      });
    if (event.kind === 9000) channels.get(tag("h"))?.members.push(tag("p"));
    clock++;
  });
  const start = () =>
    createRelaySession(
      {
        viewer: identity.pubkey,
        relayAuthor: authority.pubkey,
        scope: COMMUNITY,
        media: () => undefined,
        query,
        writer: {
          kinds: [9, 9000, 9007, 30177, 46020, 5],
          sign,
          publish,
        },
        workflows: { runs: async () => ({ runs: [], next: null }) },
      },
      {
        outboxStorage: {
          load: () => structuredClone(saved),
          save: (next) => {
            saved = structuredClone(next);
          },
          close: () => closed.resolve(),
        },
      },
    );
  let owner = start();
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    viewer: identity.pubkey,
    origin: COMMUNITY,
    scope: relayPartition(COMMUNITY, identity.pubkey),
    session: owner.session,
  };
  const community: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    viewer: identity.pubkey,
    selected: COMMUNITY,
    memberships: [],
    profile: { name: "", picture: "", about: "" },
  };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const reader = { snapshot: () => community, subscribe: relay.subscribe };

  const root = new Context();
  const runtime = new PluginRuntime(root, async (plugin) =>
    plugin.manifest.id === builderlabManifest.id ? builderlab : bestiePlugin,
  );
  new HostService(root);
  new SettingsCardsService(root);
  new ConversationService(root);
  new PanelsService(root);
  const pages = new PagesService(root);
  const open = vi.fn(async () => ({ status: "opened" }));
  const navigation = { open } as unknown as Navigation;
  root.provide("relay", relay);
  root.provide("navigation", navigation);
  const agents = new AgentsService(
    root,
    { ...reader, open: () => relay } as unknown as AgentCommunities,
    {
      list: async () => [],
      create: vi.fn(),
      portable: vi.fn(),
      port: vi.fn(),
      rename: vi.fn(),
      setType: vi.fn(),
      setPicture: vi.fn(),
      remove: vi.fn(),
      beginDelete: vi.fn(),
      forget: vi.fn(),
      publish: vi.fn(),
      publishProfile: vi.fn(),
      query: vi.fn(),
      searchProfiles: vi.fn(),
      upload: vi.fn(),
      media: vi.fn(),
      remember: vi.fn(),
      gitAuth: vi.fn(),
      claim: async () => true,
      release: vi.fn(),
    },
  );
  const plugin = (manifest: { id: string; name: string }): PluginInfo => ({
    manifest: { ...manifest, apiVersion: 1 },
    source: "bundled",
    revision: "bundled",
    enabled: true,
    previous: null,
    reloadable: false,
    error: null,
  });
  runtime.reconcile([plugin(builderlabManifest), plugin(bestieManifest)]);
  await vi.waitFor(() => {
    if (!root.get("builderlab")) throw new Error("Builderlab not provided");
    if (agents.snapshot().status !== "ready")
      throw new Error("Agents not ready");
    if (!pages.snapshot().length) throw new Error("Bestie page missing");
  });
  const provided = root.get("builderlab");
  if (!provided) throw new Error("Builderlab not provided");
  const bestie = createRemoteBestie(provided, agents, relay);
  cleanups.push(async () => {
    bestie.dispose();
    await runtime.dispose();
    await root.fiber.dispose();
    owner.dispose();
    await closed.promise;
    listeners.clear();
  });
  return {
    bestie,
    agents,
    pages,
    open,
    navigation,
    events,
    channels,
    rows,
    sign,
    publish,
    query,
    viewer: identity.pubkey,
    agent: remote.pubkey,
    requests: (path: string) =>
      invoke.mock.calls.filter(
        ([command, input]) =>
          command === "plugin_host_request" &&
          (input as { request: { url: string } }).request.url.endsWith(
            `/${path}`,
          ),
      ),
    reply(path: string, status: number, body: unknown) {
      replies.set(path, { status, body });
    },
    holdRequest(path: string) {
      const gate = deferred<void>();
      holds.set(path, gate.promise);
      return gate;
    },
    cancelNextSignIn() {
      signInCanceled = true;
    },
    failPublication(kind: number) {
      failKind = kind;
    },
    addMember(pubkey: string) {
      for (const home of channels.values()) home.members.push(pubkey);
      clock++;
    },
    async restart() {
      await owner.session.outbox?.ready();
      owner.dispose();
      await closed.promise;
      closed = deferred<void>();
      owner = start();
      snapshot = {
        ...snapshot,
        session: owner.session,
        generation: snapshot.generation + 1,
      };
      notify();
      await owner.session.outbox?.ready();
    },
  };
}
