import { describe, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import type { RelaySession } from "../relay/session";
import { keypair, signed } from "../relay/testing";
import type { RelayWriter } from "../relay/transport";
import { AgentConfigStore } from "./agent-config";
import {
  ARTIFACT_MAX_EVENT_BYTES,
  artifactD,
  artifactTemplate,
  type SnapshotRead,
} from "./agent-config-artifacts";
import { revertTemplate } from "./agent-config-history";
import { resolveStart } from "./agent-start";
import {
  agentConfigs,
  CONFIG_SYNC_ENABLED,
  communityConfig,
} from "./community-config";
import { PublishRejected } from "../relay/outbox";
import { LifecycleJournal } from "./config-lifecycle";
import { MigrationJournal } from "./config-writes";
import { TeamJournal } from "./team-config";
import { memoryStorage } from "./test-fakes";

const owner = keypair();
const agent = { pubkey: keypair().pubkey, name: "Scout", type: "goose" };
const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const artifacts = { version: 1, revision_kind: 45010 };
const supported = { supported_extensions: ["nip-cl", "nip-ar"], artifacts };

function session() {
  return {
    snapshotRead: async () => [],
    relayAuthor: "r".repeat(64),
    configArtifactWriter: { sign: vi.fn(), publish: vi.fn() },
    live: {
      snapshot: () => ({ status: "connected", routes: [] }),
      subscribe: () => () => {},
    },
    configScope() {},
    onConfig: () => () => {},
    configGeneration: () => 0,
  } as unknown as RelaySession;
}

const journals = (storage: Storage) => ({
  migration: new MigrationJournal(storage),
  teams: new TeamJournal(storage),
  lifecycle: new LifecycleJournal(storage),
});

const gate = (enabled: boolean | undefined, info: () => Promise<unknown>) =>
  communityConfig(
    {
      session: session(),
      owner: owner.pubkey,
      community: "c",
      store: new AgentConfigStore(memoryStorage()),
      journals: journals(memoryStorage()),
      info,
      strip() {},
      changed() {},
      ...(enabled === undefined ? {} : { enabled }),
    },
    new AbortController().signal,
  );

describe("community config gate", () => {
  it("reselects an agent's channel when the relay's discovery reports it", async () => {
    const relay = keypair();
    const listeners: ((event: RelayEvent) => void)[] = [];
    const findLabeled = vi.fn(async () => {
      throw new Error("offline");
    });
    const configs = await communityConfig(
      {
        session: {
          ...session(),
          relayAuthor: relay.pubkey,
          onConfig: (listener: (event: RelayEvent) => void) => {
            listeners.push(listener);
            return () => {};
          },
          channels: { findLabeled },
        } as unknown as RelaySession,
        owner: owner.pubkey,
        community: "c",
        store: new AgentConfigStore(memoryStorage()),
        journals: journals(memoryStorage()),
        info: async () => supported,
        strip() {},
        changed() {},
        enabled: true,
      },
      new AbortController().signal,
    );
    await configs?.attach([{ ...agent, pubkey: owner.pubkey, config: {} }]);
    expect(findLabeled).toHaveBeenCalledTimes(1);
    const metadata = await signed(relay, {
      kind: 39000,
      content: "",
      created_at: 1,
      tags: [
        ["d", channel],
        ["P", owner.pubkey],
        ["t", "agent-config"],
        ["t", owner.pubkey],
      ],
    });
    for (const listener of listeners) listener(metadata);
    await vi.waitFor(() => expect(findLabeled).toHaveBeenCalledTimes(2));
    configs?.dispose();
  });

  it("re-reads its teams when the relay's discovery reports a team channel", async () => {
    const relay = keypair();
    const listeners: ((event: RelayEvent) => void)[] = [];
    const findLabeled = vi.fn(async (_query: { label: string }) => []);
    const configs = await communityConfig(
      {
        session: {
          ...session(),
          relayAuthor: relay.pubkey,
          onConfig: (listener: (event: RelayEvent) => void) => {
            listeners.push(listener);
            return () => {};
          },
          channels: { findLabeled },
        } as unknown as RelaySession,
        owner: owner.pubkey,
        community: "c",
        store: new AgentConfigStore(memoryStorage()),
        journals: journals(memoryStorage()),
        info: async () => supported,
        strip() {},
        changed() {},
        enabled: true,
      },
      new AbortController().signal,
    );
    const teamReads = () =>
      findLabeled.mock.calls.filter(([query]) => query.label === "team-config")
        .length;
    const metadata = await signed(relay, {
      kind: 39000,
      content: "",
      created_at: 1,
      tags: [
        ["d", "0c9e7a52-3b1d-4f6e-8a20-6d4b2f9e1c33"],
        ["P", owner.pubkey],
        ["t", "team-config"],
        ["t", "team-5d2f6c1e"],
      ],
    });
    for (const listener of listeners) listener(metadata);
    await vi.waitFor(() => expect(teamReads()).toBe(1));
    configs?.dispose();
  });

  it("ships off and touches nothing while off", async () => {
    expect(CONFIG_SYNC_ENABLED).toBe(false);
    const info = vi.fn(async () => supported);
    expect(await gate(undefined, info)).toBeNull();
    expect(info).not.toHaveBeenCalled();
  });

  it("stays off on a relay that fails the support check, even when enabled", async () => {
    expect(
      await gate(true, async () => ({ supported_extensions: ["nip-cl"] })),
    ).toBeNull();
    expect(
      await gate(true, async () => Promise.reject(new Error("down"))),
    ).toBeNull();
  });
});

function setup(archived = false, storage = memoryStorage()) {
  const meta = { archived, failArchive: undefined as Error | undefined };
  const state = { head: undefined as RelayEvent | undefined };
  const sent: RelayEvent[] = [];
  const read: SnapshotRead = async () => (state.head ? [state.head] : []);
  const writer: RelayWriter = {
    sign: vi.fn(async (template) => signed(owner, template)),
    async publish(event) {
      sent.push(event);
      const prev = event.tags.find((t) => t[0] === "prev")?.[1];
      if (!state.head || prev === state.head.id) state.head = event;
    },
  };
  const store = new AgentConfigStore(storage);
  const ensure = vi.fn(async () => ({ id: channel, archived: meta.archived }));
  const archive = vi.fn(async () => {
    if (meta.failArchive) throw meta.failArchive;
    meta.archived = true;
  });
  const unarchive = vi.fn(async () => {
    meta.archived = false;
  });
  const bind = vi.fn(async () => {});
  const teams = vi.fn(
    async (): Promise<
      { id: string; archived: boolean; label: string; members?: string[] }[]
    > => [],
  );
  const addMember = vi.fn(
    async (): Promise<{ status: "confirmed" | "failed"; error?: string }> => ({
      status: "confirmed",
    }),
  );
  const local = { instructions: "Be brief.", stripped: [] as string[] };
  const configs = agentConfigs({
    channels: {
      ensure,
      teams,
      addMember,
      owns: vi.fn(async () => true),
      archive,
      unarchive,
      archived: vi.fn(async () => meta.archived),
    },
    teamJournal: new TeamJournal(storage),
    lifecycle: new LifecycleJournal(storage),
    sync: { bind, unbind: vi.fn(), dispose() {} },
    deps: {
      read,
      writer,
      store,
      journal: new MigrationJournal(storage),
      maxEventBytes: ARTIFACT_MAX_EVENT_BYTES,
      signal: new AbortController().signal,
    },
    owner: owner.pubkey,
    community: "c",
    strip: (_, side) => void local.stripped.push(side),
    changed() {},
  });
  const start = () => {
    const instructions = configs.binding(agent.pubkey)?.instructions;
    return resolveStart({
      store,
      local: { instructions: local.instructions },
      agentType: agent.type,
      ...(instructions ? { instructions } : {}),
    });
  };
  const me = () => ({ ...agent, config: { instructions: local.instructions } });
  return {
    configs,
    ensure,
    bind,
    sent,
    state,
    store,
    local,
    start,
    me,
    meta,
    archive,
    storage,
    writer,
    addMember,
    teams,
  };
}

/** Discovery's metadata for the agent's config channel. */
const metadata = {
  tags: [
    ["t", "agent-config"],
    ["t", agent.pubkey],
  ],
} as RelayEvent;

describe("agent config wiring", () => {
  it("ensures the agent's channel, binds it and migrates instructions to synced", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    expect(f.ensure).toHaveBeenCalledWith(
      "agent-config",
      agent.pubkey,
      "Scout config",
      expect.anything(),
    );
    expect(f.bind).toHaveBeenCalledWith([
      { family: "agent-config", subject: agent.pubkey, channel },
    ]);
    expect(f.configs.binding(agent.pubkey)?.instructions?.mode).toBe("synced");
    expect(f.local.stripped).toEqual(["instructions"]);
    f.local.instructions = "stale local row";
    expect(f.start()).toMatchObject({
      ok: true,
      config: { instructions: "Be brief." },
    });
  });

  it("leaves an archived agent's channel to the archive lifecycle", async () => {
    const f = setup(true);
    await f.configs.attach([f.me()]);
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.configs.binding(agent.pubkey)).toBeUndefined();
  });

  it("stays local when the channel can't be ensured, and retries on the next connection", async () => {
    const f = setup();
    f.ensure.mockRejectedValueOnce(new Error("offline"));
    await f.configs.attach([f.me()]);
    expect(f.configs.binding(agent.pubkey)).toBeUndefined();
    await f.configs.attach([f.me()]);
    expect(f.ensure).toHaveBeenCalledTimes(1);
    await f.configs.reconnected();
    expect(f.configs.binding(agent.pubkey)?.instructions?.mode).toBe("synced");
  });

  it("saves a synced edit as the next revision and starts from it", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    const first = f.sent[0];
    const result = await f.configs.save(f.me(), { instructions: "Be kind." });
    expect(result.instructions?.status).toBe("saved");
    expect(f.sent[1]?.tags).toContainEqual(["prev", first?.id]);
    expect(f.start()).toMatchObject({ config: { instructions: "Be kind." } });
  });

  it("publishes nothing for an edit that leaves synced fields unchanged", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    expect(await f.configs.save(f.me(), { instructions: "Be brief." })).toEqual(
      {},
    );
    expect(f.sent).toHaveLength(1);
  });

  it("never publishes a retired local field as an empty revision", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    expect(await f.configs.save(f.me(), { model: "x" })).toEqual({});
    expect(f.sent).toHaveLength(1);
    expect(f.start()).toMatchObject({ config: { instructions: "Be brief." } });
  });

  it("gives starts the teams whose channel lists the agent, once teams are known", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    expect(f.configs.binding(agent.pubkey)?.teams).toBeUndefined();
    await f.configs.refreshTeams();
    expect(f.configs.binding(agent.pubkey)?.teams).toEqual([]);
  });

  it("re-reads a team's members when its channel roster changes", async () => {
    const storage = memoryStorage();
    const channel = "6f1c2a3b-4d5e-4f60-8a71-b2c3d4e5f607";
    const teamId = "0b7d4e2a-9c31-5f84-a6d2-3e1f0c9b8a75";
    // Known from an earlier discovery, so its unprovable label keeps its id.
    new TeamJournal(storage).remember(owner.pubkey, "c", [
      {
        id: teamId,
        channel,
        archived: false,
        unreadable: true,
        members: [],
        subject: {
          owner: owner.pubkey,
          community: "c",
          subject: teamId,
          channel,
          type: "buzz.team",
        },
      },
    ]);
    const f = setup(false, storage);
    const team = {
      id: channel,
      archived: false,
      label: "team-x",
      members: [] as string[],
    };
    f.teams.mockImplementation(async () => [team]);
    await f.configs.attach([f.me()]);
    await f.configs.refreshTeams();
    const listed = () =>
      f.configs.binding(agent.pubkey)?.teams?.map((t) => t.id) ?? [];
    expect(listed()).toEqual([]);
    team.members = [agent.pubkey];
    f.configs.rosterChanged("elsewhere");
    f.configs.rosterChanged(channel);
    await vi.waitFor(() => expect(listed()).toEqual([teamId]));
  });

  it("adds the agent to its own config channel before binding it", async () => {
    const f = setup();
    f.addMember.mockResolvedValueOnce({ status: "failed", error: "denied" });
    await f.configs.attach([f.me()]);
    expect(f.addMember).toHaveBeenCalledWith(
      channel,
      agent.pubkey,
      expect.anything(),
    );
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.configs.binding(agent.pubkey)).toBeUndefined();
    await f.configs.reconnected();
    expect(f.bind).toHaveBeenCalledTimes(1);
    expect(f.configs.binding(agent.pubkey)?.instructions?.mode).toBe("synced");
  });

  it("binds again when discovery reports the agent's config channel", async () => {
    const f = setup();
    f.ensure.mockRejectedValueOnce(new Error("offline"));
    await f.configs.attach([f.me()]);
    expect(f.configs.binding(agent.pubkey)).toBeUndefined();
    f.configs.discovered(metadata);
    await vi.waitFor(() =>
      expect(f.configs.binding(agent.pubkey)?.instructions?.mode).toBe(
        "synced",
      ),
    );
  });

  it("resends a held save on reconnect", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    const publish = f.writer.publish;
    f.writer.publish = async (event) => {
      f.sent.push(event);
      throw new Error("socket closed");
    };
    const result = await f.configs.save(f.me(), { instructions: "Be kind." });
    expect(result.instructions?.status).toBe("uncertain");
    f.writer.publish = publish;
    await f.configs.reconnected();
    expect(f.sent.at(-1)?.id).toBe(f.sent[1]?.id);
    expect(f.state.head?.id).toBe(f.sent[1]?.id);
    expect(f.start()).toMatchObject({ config: { instructions: "Be kind." } });
  });

  it("saves against the head the editor opened, keeping its unknown fields and tags", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    const first = f.sent[0] as RelayEvent;
    const newer = await signed(
      owner,
      artifactTemplate({
        channel,
        type: "buzz.agent.instructions",
        d: await artifactD("buzz.agent.instructions", channel),
        op: "update",
        prev: first.id,
        title: "Agent instructions",
        content: JSON.stringify({ version: 1, text: "Theirs", future: 7 }),
        extra: [["client-tag", "kept"]],
      }),
    );
    // Another device's revision lands while this one saves: it is installed.
    const publish = f.writer.publish;
    f.writer.publish = async () => {
      f.writer.publish = publish;
      f.state.head = newer;
      throw new PublishRejected("refused", "conflict: stale prev");
    };
    await f.configs.save(f.me(), { instructions: "Lost" });
    const subject = f.configs.binding(agent.pubkey)?.instructions?.subject;
    expect(subject && f.store.state(subject).head?.id).toBe(newer.id);
    const sent = f.sent.length;
    const stale = { instructions: first };
    // An editor still showing the first head conflicts without sending.
    const lost = await f.configs.save(f.me(), { instructions: "Mine" }, stale);
    expect(lost.instructions?.status).toBe("conflict");
    expect(f.sent).toHaveLength(sent);
    const saved = await f.configs.save(
      f.me(),
      { instructions: "Mine" },
      { instructions: newer },
    );
    expect(saved.instructions?.status).toBe("saved");
    const last = f.sent.at(-1);
    expect(last?.tags).toContainEqual(["prev", newer.id]);
    expect(last?.tags).toContainEqual(["client-tag", "kept"]);
    expect(JSON.parse(last?.content ?? "")).toEqual({
      version: 1,
      text: "Mine",
      future: 7,
    });
  });
});

describe("agent config history wiring", () => {
  it("lists a synced side's History and restores a deleted head with op=restore", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    const first = f.sent[0] as RelayEvent;
    const [side] = f.configs.history(agent.pubkey);
    expect(side).toMatchObject({
      side: "instructions",
      head: first,
      version: 0,
    });
    if (!side) throw new Error("no History");
    // Another device deletes the instructions: starts block on the deletion.
    const removal = artifactTemplate({
      ...side.expected,
      op: "update",
      prev: first.id,
      title: "Agent instructions",
      content: "{}",
    });
    const deleted = await signed(owner, {
      ...removal,
      content: "",
      tags: removal.tags.map((tag) =>
        tag[0] === "op" ? ["op", "delete"] : tag,
      ),
    });
    f.state.head = deleted;
    const subject = f.configs.binding(agent.pubkey)?.instructions?.subject;
    if (!subject) throw new Error("not synced");
    f.store.applyRead(subject, f.store.capture(subject), {
      kind: "head",
      event: deleted,
    });
    expect(f.start()).toMatchObject({ ok: false });
    const head = f.configs.history(agent.pubkey)[0]?.head;
    expect(head?.id).toBe(deleted.id);
    const saved = await f.configs.revise(
      agent.pubkey,
      "instructions",
      revertTemplate(side.expected, deleted, first),
    );
    expect(saved.status).toBe("saved");
    expect(f.sent.at(-1)?.tags).toContainEqual(["op", "restore"]);
    expect(f.sent.at(-1)?.tags).toContainEqual(["prev", deleted.id]);
    expect(f.start()).toMatchObject({
      ok: true,
      config: { instructions: "Be brief." },
    });
  });

  it("reloads History when a redaction changes it without a new head", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    const [side] = f.configs.history(agent.pubkey);
    if (!side) throw new Error("no History");
    f.configs.historyChanged(side.expected.channel, side.expected.d);
    expect(f.configs.history(agent.pubkey)[0]?.version).toBe(1);
    f.configs.historyChanged(side.expected.channel, "another");
    expect(f.configs.history(agent.pubkey)[0]?.version).toBe(1);
  });
});

describe("agent archive and recover wiring", () => {
  it("archives the agent's channel, drops its binding and lists it as deleted", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    expect(await f.configs.archive(agent.pubkey)).toBe("archived");
    expect(f.configs.lifecycle(agent.pubkey)).toBe("archived");
    expect(f.configs.binding(agent.pubkey)).toBeUndefined();
  });

  it("keeps an unconfirmed archive pending across a restart, then settles it", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    f.meta.failArchive = new Error("timeout");
    expect(await f.configs.archive(agent.pubkey)).toBe("archiving");
    const again = setup(false, f.storage);
    expect(again.configs.lifecycle(agent.pubkey)).toBe("archiving");
    await again.configs.attach([again.me()]);
    expect(again.bind).not.toHaveBeenCalled();
    await again.configs.resume();
    expect(again.configs.lifecycle(agent.pubkey)).toBe("archived");
  });

  it("rolls an archive back only on a definite refusal with active metadata", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    f.meta.failArchive = new PublishRejected(
      "refused",
      "restricted: not yours",
    );
    expect(await f.configs.archive(agent.pubkey)).toBe("active");
    expect(f.bind).toHaveBeenCalledTimes(2);
    expect(f.configs.binding(agent.pubkey)?.instructions?.mode).toBe("synced");
  });

  it("admits an archive made on another device when discovery reports it", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    f.meta.archived = true;
    f.configs.discovered(metadata);
    await vi.waitFor(() =>
      expect(f.configs.lifecycle(agent.pubkey)).toBe("archived"),
    );
    expect(f.configs.binding(agent.pubkey)).toBeUndefined();
    expect(f.start()).toMatchObject({ ok: true });
  });

  it("settles a pending archive when discovery reports the channel archived", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    f.meta.failArchive = new Error("lost OK");
    await f.configs.archive(agent.pubkey);
    const again = setup(true, f.storage);
    await again.configs.attach([again.me()]);
    expect(again.configs.lifecycle(agent.pubkey)).toBe("archived");
  });

  it("recovers to active and rebinds the channel before starts use it", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    await f.configs.archive(agent.pubkey);
    expect(await f.configs.recover(agent.pubkey)).toBe("active");
    expect(f.bind).toHaveBeenCalledTimes(2);
    expect(f.configs.binding(agent.pubkey)?.instructions?.mode).toBe("synced");
    expect(f.start()).toMatchObject({ ok: true });
  });

  it("installs an invalid head found on recovery as invalid, never present", async () => {
    const f = setup();
    await f.configs.attach([f.me()]);
    await f.configs.archive(agent.pubkey);
    const first = f.sent[0] as RelayEvent;
    f.state.head = await signed(owner, {
      kind: first.kind,
      content: first.content,
      created_at: first.created_at + 1,
      tags: first.tags.map((t) => (t[0] === "h" ? ["h", "elsewhere"] : t)),
    });
    expect(await f.configs.recover(agent.pubkey)).toBe("active");
    const subject = f.configs.binding(agent.pubkey)?.instructions?.subject;
    expect(subject && f.store.state(subject).state).toBe("invalid");
    expect(f.start()).toMatchObject({ ok: false, state: "invalid" });
  });
});
