import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { PublishRejected } from "../relay/outbox";
import { keypair, signed } from "../relay/testing";
import {
  ARTIFACT_MAX_EVENT_BYTES,
  artifactD,
  artifactTemplate,
} from "./agent-config-artifacts";
import { AgentConfigStore } from "./agent-config";
import { MIGRATION_STORAGE_KEY } from "./config-writes";
import {
  OPS_BYTE_LIMIT,
  OPS_RECORD_LIMIT,
  STORAGE_FULL,
  TEAM_OPS_KEY,
  type TeamOp,
  TeamOps,
  teamRunner,
  unresolved,
} from "./team-ops";
import { memoryStorage } from "./test-fakes";

const owner = keypair();
const other = keypair();
const community = "wss://relay.example";
const CH = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const a = keypair().pubkey;
const b = keypair().pubkey;
const team = { name: "Core", instructions: "Ship it.", members: [a, b] };

type Gate = { promise: Promise<void>; open(): void };
const gate = (): Gate => {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/** One fake community: a team channel with a head, roster and archive flag,
 * and a log of every privileged command and publish, in order. */
function world(options: { exists?: boolean; agents?: string[] } = {}) {
  const storage = memoryStorage();
  const relay = {
    exists: options.exists ?? false,
    archived: false,
    head: undefined as RelayEvent | undefined,
    stored: [] as RelayEvent[],
    roster: new Set<string>(),
  };
  const log: string[] = [];
  const agents = new Set(options.agents ?? [a, b]);
  const hooks = {
    publish: undefined as ((event: RelayEvent) => Promise<void>) | undefined,
    read: undefined as (() => Promise<void>) | undefined,
    add: undefined as ((pubkey: string) => Promise<unknown>) | undefined,
    archive: undefined as (() => Promise<void>) | undefined,
  };
  /** The relay's own acceptance: a create needs an unused `d`, an update
   * the current head as `prev`. */
  const accept = (event: RelayEvent) => {
    const prev = event.tags.find((t) => t[0] === "prev")?.[1];
    if (relay.head ? prev !== relay.head.id : prev)
      throw new PublishRejected("conflict", "conflict: stale head");
    relay.head = event;
    relay.stored.push(event);
  };
  const read = vi.fn(async (filters: readonly ReadFilter[]) => {
    await hooks.read?.();
    const [filter] = filters;
    if (filter?.ids)
      return relay.stored.filter((event) => filter.ids?.includes(event.id));
    return relay.head ? [relay.head] : [];
  });
  const writer = {
    sign: vi.fn(async (template: Parameters<typeof signed>[1]) =>
      signed(owner, template),
    ),
    publish: vi.fn(async (event: RelayEvent) => {
      log.push(`publish ${event.tags.find((t) => t[0] === "op")?.[1]}`);
      if (hooks.publish) return hooks.publish(event);
      accept(event);
    }),
  };
  const channel = () => ({
    id: CH,
    archived: relay.archived,
    members: [owner.pubkey, ...relay.roster],
  });
  const channels = {
    find: vi.fn(async (family: string, subject: string) => {
      if (family === "agent-config")
        return agents.has(subject)
          ? { id: `agent-${subject}`, archived: false }
          : undefined;
      return relay.exists ? channel() : undefined;
    }),
    ensure: vi.fn(async () => {
      relay.exists = true;
      return channel();
    }),
    archive: vi.fn(async () => {
      log.push("archive");
      if (hooks.archive) return hooks.archive();
      relay.archived = true;
    }),
    unarchive: vi.fn(async () => {
      log.push("unarchive");
      relay.archived = false;
    }),
    archived: vi.fn(async () => relay.archived),
    addMember: vi.fn(async (_: string, pubkey: string) => {
      log.push(`add ${pubkey}`);
      if (hooks.add) return hooks.add(pubkey) as never;
      relay.roster.add(pubkey);
      return { status: "confirmed" as const };
    }),
    removeMember: vi.fn(async (_: string, pubkey: string) => {
      log.push(`remove ${pubkey}`);
      relay.roster.delete(pubkey);
      return { status: "confirmed" as const };
    }),
    owns: vi.fn(async (pubkey: string) => agents.has(pubkey)),
  };
  const done = vi.fn();
  const make = (ops: TeamOps, who = owner.pubkey, where = community) =>
    teamRunner({
      read,
      writer,
      maxEventBytes: ARTIFACT_MAX_EVENT_BYTES,
      signal: new AbortController().signal,
      channels,
      sync: { bind: vi.fn(async () => {}) },
      store: new AgentConfigStore(storage),
      ops,
      owner: who,
      community: where,
      done,
      changed() {},
    });
  let ops = new TeamOps(storage);
  const w = {
    storage,
    relay,
    log,
    hooks,
    read,
    writer,
    channels,
    done,
    agents,
    accept,
    get ops() {
      return ops;
    },
    runner: make(ops),
    make,
    /** A restart: the records reload from storage, with no memory. */
    restart() {
      ops = new TeamOps(storage);
      w.runner = make(ops);
      return w.runner;
    },
  };
  return w;
}

/** A team revision as any device would sign it, on the current head. */
async function revision(
  w: ReturnType<typeof world>,
  teamId: string,
  body: { name: string; instructions: string },
  key = other,
) {
  const head = w.relay.head;
  return signed(
    key,
    artifactTemplate({
      channel: CH,
      type: "buzz.team",
      d: await artifactD("buzz.team", CH),
      team: teamId,
      title: body.name,
      content: JSON.stringify({ version: 1, ...body }),
      ...(head
        ? { op: "update" as const, prev: head.id }
        : { op: "create" as const }),
      extra: [["team", teamId]],
    }),
  );
}

/** A team that exists on the relay, made elsewhere, with `roster`. */
async function existing(
  w: ReturnType<typeof world>,
  roster: string[] = [a, b],
) {
  const teamId = crypto.randomUUID();
  w.relay.exists = true;
  w.accept(await revision(w, teamId, team));
  for (const pubkey of roster) w.relay.roster.add(pubkey);
  return teamId;
}

const edit = (
  w: ReturnType<typeof world>,
  teamId: string,
  intent: Partial<typeof team> = {},
) =>
  w.runner.start({
    kind: "edit",
    teamId,
    channel: CH,
    base: w.relay.head?.id ?? null,
    intent: { ...team, ...intent },
  });

const record = (w: ReturnType<typeof world>, id: string) =>
  w.ops.get(id) as TeamOp;

describe("team operations: witnesses", () => {
  it("1: a second stale form on one device conflicts and keeps its draft", async () => {
    const w = world();
    const teamId = await existing(w);
    const first = edit(w, teamId, { instructions: "First" });
    const second = edit(w, teamId, { instructions: "Second" });
    expect(await first.done).toBeUndefined();
    const after = await second.done;
    expect(after).toMatchObject({ stop: "conflict", mode: "reconcile-only" });
    expect(after?.intent.instructions).toBe("Second");
    expect(JSON.parse(w.relay.head?.content ?? "").instructions).toBe("First");
  });

  it("2: H accepted, then J on top: no members touched, stopped as conflict", async () => {
    const w = world();
    const teamId = await existing(w, [a]);
    w.hooks.publish = async (event) => {
      w.accept(event);
      w.accept(await revision(w, teamId, { ...team, instructions: "J" }));
    };
    const { done } = edit(w, teamId, { instructions: "H" });
    expect(await done).toMatchObject({ stop: "conflict" });
    expect(w.channels.addMember).not.toHaveBeenCalled();
  });

  it("3: an unreadable lookup is unresolved; a later fresh read resolves a lost reply", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async (event) => {
      w.accept(event);
      throw new Error("connection lost");
    };
    const { op, done } = edit(w, teamId, { instructions: "H" });
    expect(unresolved((await done) as TeamOp)).toBe(true);
    w.hooks.publish = undefined;
    w.hooks.read = async () => {
      throw new Error("redacted");
    };
    expect(unresolved((await w.runner.run(op.id)) as TeamOp)).toBe(true);
    w.hooks.read = undefined;
    expect(await w.runner.run(op.id)).toBeUndefined();
    expect(w.writer.sign).toHaveBeenCalledTimes(1);
  });

  it("4: H accepted, reply lost, restart: resumes with H confirmed, no replacement", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async (event) => {
      w.accept(event);
      throw new Error("connection lost");
    };
    const { op, done } = edit(w, teamId, { instructions: "H" });
    const held = ((await done) as TeamOp).candidate?.event.id;
    w.hooks.publish = undefined;
    w.restart();
    await w.runner.resume();
    expect(w.ops.get(op.id)).toBeUndefined();
    expect(w.relay.head?.id).toBe(held);
    expect(w.writer.sign).toHaveBeenCalledTimes(1);
    expect(w.writer.publish).toHaveBeenCalledTimes(1);
  });

  it("5: save confirmed, a member add fails, restart: only that member's command remains", async () => {
    const w = world();
    const teamId = await existing(w, []);
    w.hooks.add = async (pubkey) => {
      if (pubkey === b) return { status: "failed", error: "nope" };
      w.relay.roster.add(pubkey);
      return { status: "confirmed" };
    };
    const { op, done } = edit(w, teamId, { instructions: "New" });
    await done;
    w.restart();
    expect(record(w, op.id).commands).toEqual([
      { action: "add", pubkey: a, state: "confirmed" },
      { action: "add", pubkey: b, state: "refused", error: "nope" },
    ]);
    w.hooks.add = undefined;
    w.log.length = 0;
    expect(await w.runner.run(op.id)).toBeUndefined();
    expect(w.log).toEqual([`add ${b}`]);
  });

  it("6: a never-confirmed member removed in the form: the add drops and no removal is sent", async () => {
    const w = world({ agents: [a] });
    const teamId = await existing(w, []);
    const { op, done } = edit(w, teamId, { members: [a, b] });
    expect(record(w, op.id) ?? (await done)).toBeDefined();
    await done;
    // b has no agent channel yet, so its add stays planned.
    expect(record(w, op.id).commands).toContainEqual({
      action: "add",
      pubkey: b,
      state: "planned",
    });
    w.runner.revise(op.id, { ...team, members: [a] });
    expect(await w.runner.run(op.id)).toBeUndefined();
    expect(w.channels.removeMember).not.toHaveBeenCalled();
    expect(w.log).not.toContain(`add ${b}`);
  });

  it("7: after an uncertain save, a rename and back resends the held bytes and re-signs nothing", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async () => {
      throw new Error("timeout");
    };
    const { op, done } = edit(w, teamId, { name: "Renamed" });
    const held = ((await done) as TeamOp).candidate?.event;
    w.runner.revise(op.id, { ...team, name: "Other" });
    w.runner.revise(op.id, { ...team, name: "Renamed" });
    w.hooks.publish = undefined;
    expect(await w.runner.run(op.id)).toBeUndefined();
    expect(w.writer.sign).toHaveBeenCalledTimes(1);
    expect(w.writer.publish.mock.calls.map(([e]) => e)).toEqual([held, held]);
  });

  it("8: Discard moves to reconcile-only and keeps the evidence", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async () => {
      throw new Error("timeout");
    };
    const { op, done } = edit(w, teamId, { name: "Renamed" });
    await done;
    w.runner.discard(op.id);
    expect(record(w, op.id)).toMatchObject({
      mode: "reconcile-only",
      stop: "discarded",
      candidate: expect.anything(),
    });
    expect(() => w.runner.dismiss(op.id)).toThrow();
    w.hooks.publish = undefined;
    await w.runner.run(op.id);
    expect(w.writer.publish).toHaveBeenCalledTimes(1);
  });

  it("9: a rejected step, then another on the same team runs; the caller gets the original error", async () => {
    const w = world();
    const teamId = await existing(w);
    w.writer.sign.mockRejectedValueOnce(new Error("signer gone"));
    const first = edit(w, teamId, { name: "One" });
    const second = edit(w, teamId, { name: "Two" });
    await expect(first.done).rejects.toThrow("signer gone");
    w.runner.discard(first.op.id);
    expect(await second.done).toBeUndefined();
    expect(JSON.parse(w.relay.head?.content ?? "").name).toBe("Two");
  });

  it("10: a Delete submitted during a paused member change archives only after it, held by the fence", async () => {
    const w = world();
    const teamId = await existing(w, []);
    const paused = gate();
    w.hooks.add = async (pubkey) => {
      await paused.promise;
      w.relay.roster.add(pubkey);
      return { status: "confirmed" };
    };
    const change = edit(w, teamId);
    await vi.waitFor(() => expect(w.log).toContain(`add ${a}`));
    const deletion = w.runner.start({
      kind: "delete",
      teamId,
      channel: CH,
      intent: { name: "", instructions: "", members: [] },
    });
    paused.open();
    await change.done;
    expect(await deletion.done).toBeUndefined();
    expect(w.log).toEqual([`add ${a}`, "archive"]);
  });

  it("runs one step of a change at a time, so a second run never resends bytes still being sent", async () => {
    const w = world();
    const teamId = await existing(w);
    const sending = gate();
    const entered = gate();
    w.hooks.publish = async (event) => {
      entered.open();
      await sending.promise;
      w.accept(event);
    };
    const change = edit(w, teamId, { name: "Renamed" });
    await entered.promise;
    const again = w.runner.run(change.op.id);
    sending.open();
    await change.done;
    await again;
    expect(w.log.filter((line) => line.startsWith("publish"))).toEqual([
      "publish update",
    ]);
  });

  it("11: Delete then Recover with H unchanged: the old record's pending add never runs", async () => {
    const w = world({ agents: [a] });
    const teamId = await existing(w, []);
    const old = edit(w, teamId, { members: [a, b] });
    await old.done;
    const lifecycle = { name: "", instructions: "", members: [] };
    await w.runner.start({
      kind: "delete",
      teamId,
      channel: CH,
      intent: lifecycle,
    }).done;
    await w.runner.start({
      kind: "recover",
      teamId,
      channel: CH,
      intent: lifecycle,
    }).done;
    w.agents.add(b);
    await w.runner.run(old.op.id);
    expect(w.log).not.toContain(`add ${b}`);
    expect(record(w, old.op.id)).toMatchObject({ stop: "deleted" });
  });

  it("12: an uncertain Delete, then a read showing active: nothing is resent; Recover and members stay fenced", async () => {
    const w = world();
    const teamId = await existing(w, []);
    w.hooks.archive = async () => {
      throw new Error("timeout");
    };
    const lifecycle = { name: "", instructions: "", members: [] };
    const del = w.runner.start({
      kind: "delete",
      teamId,
      channel: CH,
      intent: lifecycle,
    });
    expect(record(w, (await del.done)?.id ?? "").commands[0]?.state).toBe(
      "maybe-sent",
    );
    await w.runner.run(del.op.id);
    const recover = w.runner.start({
      kind: "recover",
      teamId,
      channel: CH,
      intent: lifecycle,
    });
    // Recover neither completes nor dispatches while the archive may land.
    expect(await recover.done).toMatchObject({ id: recover.op.id });
    expect(record(w, recover.op.id).commands[0]?.state).toBe("planned");
    await edit(w, teamId).done;
    expect(w.log).toEqual(["archive"]);
  });

  it("13: a restart between sending a member change and recording it: maybe-sent until a roster read shows it", async () => {
    const w = world();
    const teamId = await existing(w, []);
    w.hooks.add = () => new Promise(() => {});
    const { op } = edit(w, teamId, { members: [a] });
    await vi.waitFor(() =>
      expect(record(w, op.id).commands[0]?.state).toBe("maybe-sent"),
    );
    w.hooks.add = undefined;
    w.restart();
    await w.runner.run(op.id);
    expect(w.channels.addMember).toHaveBeenCalledTimes(1);
    expect(record(w, op.id).commands[0]?.state).toBe("maybe-sent");
    w.relay.roster.add(a);
    expect(await w.runner.run(op.id)).toBeUndefined();
    expect(w.channels.addMember).toHaveBeenCalledTimes(1);
  });

  it("14: two owners and two communities don't affect each other's allowance", () => {
    const storage = memoryStorage();
    const ops = new TeamOps(storage);
    const fill = (who: string, where: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const op = base(who, where);
        ops.write({ [op.id]: op });
      }
    };
    fill("alice", community, OPS_RECORD_LIMIT);
    expect(() => fill("alice", community, 1)).toThrow(STORAGE_FULL);
    expect(() => fill("bob", community, 1)).not.toThrow();
    expect(() => fill("alice", "wss://other.example", 1)).not.toThrow();
  });

  it("15: a full budget or a throwing setItem sends nothing", async () => {
    const w = world();
    const teamId = await existing(w);
    for (let i = 0; i < OPS_RECORD_LIMIT; i++) {
      const op = base(owner.pubkey, community);
      w.ops.write({ [op.id]: op });
    }
    expect(() => edit(w, teamId)).toThrow(STORAGE_FULL);
    const v = world();
    const id = await existing(v);
    const setItem = v.storage.setItem;
    const { op, done } = edit(v, id, { name: "Renamed" });
    v.storage.setItem = (key, value) => {
      if (key === TEAM_OPS_KEY && value.includes('"candidate"'))
        throw new Error("QuotaExceededError");
      setItem(key, value);
    };
    await expect(done).rejects.toThrow(STORAGE_FULL);
    expect(v.writer.publish).not.toHaveBeenCalled();
    expect(v.ops.get(op.id)?.candidate).toBeUndefined();
  });

  it("16: a rate-limited team save leaves agent migration storage untouched; no team path uses agent writes", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async () => {
      throw new PublishRejected("slow down", "rate-limited: slow down");
    };
    const { op } = edit(w, teamId, { name: "Renamed" });
    await w.runner.run(op.id);
    // A refused first attempt frees its bytes; the change keeps sending.
    expect(record(w, op.id)).toMatchObject({
      mode: "may-send",
      error: expect.stringContaining("slow down"),
    });
    expect(record(w, op.id).candidate).toBeUndefined();
    expect(w.storage.getItem(MIGRATION_STORAGE_KEY)).toBeNull();
    for (const file of ["team-ops.ts", "team-config.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(
        /import \{[^}]*\b(write|send|resume|migrate|MigrationJournal)\b[^}]*\} from "\.\/config-writes"/,
      );
    }
  });
});

describe("team operations: corrections", () => {
  it("a first Create sends op=create with no head", async () => {
    const w = world();
    const teamId = crypto.randomUUID();
    const { done } = w.runner.start({
      kind: "create",
      teamId,
      base: null,
      intent: team,
    });
    expect(await done).toBeUndefined();
    const [sent] = w.writer.publish.mock.calls.map(([e]) => e);
    expect(sent?.tags).toContainEqual(["op", "create"]);
    expect(sent?.tags.some((t) => t[0] === "prev")).toBe(false);
    expect([...w.relay.roster]).toEqual([a, b]);
  });

  it("a members-only edit signs nothing", async () => {
    const w = world();
    const teamId = await existing(w, [a, b]);
    expect(await edit(w, teamId, { members: [a] }).done).toBeUndefined();
    expect(w.writer.sign).not.toHaveBeenCalled();
    expect(w.log).toEqual([`remove ${b}`]);
  });

  it("an adopted team's base doesn't move on retry, and its text is never replaced", async () => {
    const w = world({ agents: [a] });
    const teamId = await existing(w, []);
    const adopted = w.relay.head?.id;
    const { op, done } = w.runner.start({
      kind: "import",
      teamId,
      source: { kind: "old-buzz-team", id: "old-1" },
      intent: { name: "Imported", instructions: "Old text", members: [a, b] },
    });
    await done;
    expect(record(w, op.id)).toMatchObject({
      base: adopted,
      confirmedHead: adopted,
    });
    w.accept(await revision(w, teamId, { ...team, instructions: "Later" }));
    w.agents.add(b);
    expect(await w.runner.run(op.id)).toMatchObject({
      stop: "conflict",
      base: adopted,
    });
    expect(w.writer.sign).not.toHaveBeenCalled();
    expect(w.log).not.toContain(`add ${b}`);
  });

  it("Delete archives a team whose record can't be read", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.read = async () => {
      throw new Error("unreadable");
    };
    const { done } = w.runner.start({
      kind: "delete",
      teamId,
      channel: CH,
      intent: { name: "", instructions: "", members: [] },
    });
    expect(await done).toBeUndefined();
    expect(w.relay.archived).toBe(true);
  });

  it("Recover runs after archived metadata is seen", async () => {
    const w = world();
    const teamId = await existing(w);
    w.relay.archived = true;
    const { done } = w.runner.start({
      kind: "recover",
      teamId,
      channel: CH,
      intent: { name: "", instructions: "", members: [] },
    });
    expect(await done).toBeUndefined();
    expect(w.log).toEqual(["unarchive"]);
  });

  it("accepted, then superseded: a conflict that frees the held bytes and keeps the draft", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async (event) => {
      w.accept(event);
      w.accept(await revision(w, teamId, { ...team, instructions: "J" }));
    };
    const { op, done } = edit(w, teamId, { instructions: "H" });
    const after = (await done) as TeamOp;
    expect(after).toMatchObject({
      stop: "conflict",
      intent: { instructions: "H" },
    });
    expect(after.candidate).toBeUndefined();
    expect(after.accepted).toBe(w.relay.stored.at(-2)?.id);
    expect(() => w.runner.dismiss(op.id)).not.toThrow();
  });

  it("a superseded head alone doesn't prove a held revision was stored", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async () => {
      throw new Error("timeout");
    };
    const { op, done } = edit(w, teamId, { instructions: "H" });
    await done;
    w.hooks.publish = undefined;
    w.accept(await revision(w, teamId, { ...team, instructions: "J" }));
    const after = (await w.runner.run(op.id)) as TeamOp;
    expect(after.stop).toBe("conflict");
    expect(after.candidate).toBeDefined();
    expect(after.accepted).toBeUndefined();
    expect(() => w.runner.dismiss(op.id)).toThrow();
  });

  it("a Delete queued mid-step stops the next member command", async () => {
    const w = world();
    const teamId = await existing(w, []);
    const paused = gate();
    w.hooks.add = async (pubkey) => {
      await paused.promise;
      w.relay.roster.add(pubkey);
      return { status: "confirmed" };
    };
    const change = edit(w, teamId);
    await vi.waitFor(() => expect(w.log).toContain(`add ${a}`));
    w.runner.submit({
      kind: "delete",
      teamId,
      channel: CH,
      intent: { name: "", instructions: "", members: [] },
    });
    paused.open();
    await change.done;
    expect(w.log).not.toContain(`add ${b}`);
  });

  it("Resubmit doesn't dispatch while another record on the team has an open command fence", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async (event) => {
      w.accept(event);
      w.accept(await revision(w, teamId, { ...team, instructions: "J" }));
    };
    const stopped = (await edit(w, teamId, { instructions: "H" })
      .done) as TeamOp;
    w.hooks.publish = undefined;
    w.hooks.archive = async () => {
      throw new Error("timeout");
    };
    const lifecycle = { name: "", instructions: "", members: [] };
    // An uncertain archive, then a Recover: the archive fence stays open.
    await w.runner.start({
      kind: "delete",
      teamId,
      channel: CH,
      intent: lifecycle,
    }).done;
    w.writer.sign.mockClear();
    const again = w.runner.resubmit(stopped.id, w.relay.head?.id ?? null);
    expect(unresolved((await again.done) as TeamOp)).toBe(false);
    expect(w.writer.sign).not.toHaveBeenCalled();
  });

  it("measures a record in full serialized bytes, JSON escaping and signed envelope included", async () => {
    const ops = new TeamOps(memoryStorage());
    const event = await signed(owner, {
      kind: 45010,
      created_at: 1,
      content: "x".repeat(4096),
      tags: [["team", "t"]],
    });
    const op: TeamOp = {
      ...base(owner.pubkey, community),
      candidate: { event, sends: 1 },
      commands: [{ action: "add", pubkey: a, state: "maybe-sent" }],
    };
    const envelope = JSON.stringify({
      ...op,
      intent: { ...op.intent, instructions: "" },
    });
    // Each quote serializes as two bytes, so raw length fits but bytes don't.
    const quotes = Math.floor((OPS_BYTE_LIMIT - envelope.length) / 2) + 1;
    const big = {
      ...op,
      intent: { ...op.intent, instructions: '"'.repeat(quotes) },
    };
    expect(big.intent.instructions.length).toBeLessThan(OPS_BYTE_LIMIT);
    expect(() => ops.write({ [big.id]: big })).toThrow(STORAGE_FULL);
    const fits = {
      ...big,
      intent: { ...big.intent, instructions: '"'.repeat(quotes - 2) },
    };
    expect(() => ops.write({ [fits.id]: fits })).not.toThrow();
  });

  it("a storage failure after a member command is sent keeps its maybe-sent fence and reports it", async () => {
    const w = world();
    const teamId = await existing(w, []);
    const setItem = w.storage.setItem;
    w.hooks.add = async (pubkey) => {
      w.relay.roster.add(pubkey);
      w.storage.setItem = () => {
        throw new Error("QuotaExceededError");
      };
      return { status: "confirmed" };
    };
    const { op, done } = edit(w, teamId, { members: [a] });
    await expect(done).rejects.toThrow(STORAGE_FULL);
    w.storage.setItem = setItem;
    w.restart();
    expect(record(w, op.id).commands[0]?.state).toBe("maybe-sent");
  });
});

let seq = 0;
function base(who: string, where: string): TeamOp {
  return {
    id: crypto.randomUUID(),
    owner: who,
    community: where,
    teamId: crypto.randomUUID(),
    kind: "edit",
    intent: team,
    commands: [],
    mode: "may-send",
    seq: ++seq,
  };
}

describe("team operations: transitions", () => {
  it("a Delete submitted during an edit's head read stops it before any member command", async () => {
    const w = world();
    const teamId = await existing(w, []);
    const entered = gate(),
      release = gate();
    w.hooks.read = async () => {
      entered.open();
      await release.promise;
    };
    const old = edit(w, teamId, { members: [a] });
    await entered.promise;
    w.runner.submit({
      kind: "delete",
      teamId,
      channel: CH,
      intent: { name: "", instructions: "", members: [] },
    });
    expect(record(w, old.op.id).mode).toBe("reconcile-only");
    release.open();
    await old.done;
    expect(w.log).not.toContain(`add ${a}`);
    expect(record(w, old.op.id)).toMatchObject({
      mode: "reconcile-only",
      stop: "deleted",
    });
  });
  it("one change can add, remove and add a member back, following its latest submission", async () => {
    const w = world({ agents: [a] });
    const teamId = await existing(w, []);
    const old = edit(w, teamId, { members: [a, b] });
    await old.done;
    expect(w.relay.roster.has(a)).toBe(true);
    w.runner.revise(old.op.id, { ...team, members: [b] });
    await w.runner.run(old.op.id);
    expect(w.relay.roster.has(a)).toBe(false);
    w.runner.revise(old.op.id, { ...team, members: [a, b] });
    w.agents.add(b);
    await w.runner.run(old.op.id);
    expect(w.relay.roster.has(a)).toBe(true);
  });
  it("one change can remove, add and remove a member, following its latest submission", async () => {
    const w = world({ agents: [a] });
    const teamId = await existing(w, [a]);
    const old = edit(w, teamId, { members: [b] });
    await old.done;
    expect(w.relay.roster.has(a)).toBe(false);
    w.runner.revise(old.op.id, { ...team, members: [a, b] });
    await w.runner.run(old.op.id);
    expect(w.relay.roster.has(a)).toBe(true);
    w.runner.revise(old.op.id, { ...team, members: [b] });
    w.agents.add(b);
    await w.runner.run(old.op.id);
    expect(w.relay.roster.has(a)).toBe(false);
    expect(w.relay.roster.has(b)).toBe(true);
  });

  it("an adopted Import sends no member command through an empty head read", async () => {
    const w = world({ agents: [a] });
    const teamId = await existing(w, []);
    const old = w.runner.start({
      kind: "import",
      teamId,
      source: { kind: "old-buzz-team", id: "source" },
      intent: { ...team, members: [a, b] },
    });
    await old.done;
    w.agents.add(b);
    w.read.mockResolvedValueOnce([]);
    const before = w.log.length;
    await w.runner.run(old.op.id);
    expect(w.log.slice(before)).toEqual([]);
  });
  it("a stopped uncertain save settles from a by-id read while its head is unreadable, without becoming current", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async (event) => {
      w.accept(event);
      throw new Error("lost reply");
    };
    const old = edit(w, teamId, { instructions: "H" });
    await old.done;
    w.runner.discard(old.op.id);
    // A by-id read can still return H, but the head lookup is redacted.
    w.read.mockImplementation(async (filters) =>
      filters[0]?.ids
        ? w.relay.stored.filter((e) => filters[0]?.ids?.includes(e.id))
        : Promise.reject(new Error("head unreadable")),
    );
    await w.runner.run(old.op.id);
    expect(record(w, old.op.id).candidate).toBeUndefined();
    expect(record(w, old.op.id).accepted).toBeDefined();
    expect(record(w, old.op.id).confirmedHead).toBeUndefined();
  });
});
