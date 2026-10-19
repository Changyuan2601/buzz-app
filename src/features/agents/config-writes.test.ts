import { describe, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { PublishRejected } from "../relay/outbox";
import type { RelayWriter } from "../relay/transport";
import { keypair, signed } from "../relay/testing";
import { AgentConfigStore, type Subject } from "./agent-config";
import {
  ARTIFACT_MAX_EVENT_BYTES,
  artifactD,
  artifactTemplate,
  type SnapshotRead,
} from "./agent-config-artifacts";
import {
  type LocalSide,
  MIGRATION_STORAGE_KEY,
  MigrationJournal,
  MODE,
  migrate,
  resume,
  revise,
  edited,
  save,
} from "./config-writes";
import { memoryStorage } from "./test-fakes";

const owner = keypair();
const agent = keypair().pubkey;
const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const type = "buzz.agent.instructions";
const subject: Subject = {
  owner: owner.pubkey,
  community: "c",
  subject: agent,
  channel,
  type,
};
const body = (text: string) => JSON.stringify({ version: 1, text });

async function revision(
  content: string,
  op: "create" | "update" | "delete" = "create",
  home = channel,
) {
  const d = await artifactD(type, channel);
  const template = artifactTemplate({
    channel: home,
    type,
    d,
    op: op === "delete" ? "update" : op,
    title: "Agent instructions",
    content,
    ...(op === "create" ? {} : { prev: "a".repeat(64) }),
  });
  return signed(owner, {
    ...template,
    tags: template.tags.map((t) => (t[0] === "op" ? ["op", op] : t)),
  });
}

/** A relay holding one head for `d`. `publish` decides each send. */
function relay(
  publish: (event: RelayEvent) => void | Promise<void> = () => {},
) {
  const state = { head: undefined as RelayEvent | undefined, readable: true };
  const sent: RelayEvent[] = [];
  const read: SnapshotRead = async () =>
    state.readable && state.head ? [state.head] : [];
  const writer: RelayWriter = {
    sign: vi.fn(async (template) => signed(owner, template)),
    async publish(event) {
      sent.push(event);
      await publish(event);
      const prev = event.tags.find((t) => t[0] === "prev")?.[1];
      if (!state.head || (prev && prev === state.head.id)) state.head = event;
    },
  };
  return { state, sent, read, writer };
}

async function setup(
  publish?: (event: RelayEvent) => void | Promise<void>,
  storage = memoryStorage(),
) {
  const fake = relay(publish);
  const store = new AgentConfigStore(storage);
  const journal = new MigrationJournal(storage);
  const local = { text: "Be brief.", stripped: 0 };
  const side: LocalSide = {
    subject,
    expected: { channel, type, d: await artifactD(type, channel) },
    title: "Agent instructions",
    content: () => body(local.text),
    strip: () => void local.stripped++,
  };
  const deps = {
    read: fake.read,
    writer: fake.writer,
    store,
    journal,
    maxEventBytes: ARTIFACT_MAX_EVENT_BYTES,
    signal: new AbortController().signal,
  };
  return { ...fake, store, journal, local, side, deps, storage };
}

describe("migration journal", () => {
  it("gives every journal status exactly one launch mode", () => {
    expect(Object.keys(MODE).sort()).toEqual(
      [
        "accepted-unavailable",
        "adopted",
        "blocked",
        "confirmed",
        "dispatched",
        "failed",
        "pending",
        "staged",
        "superseded",
        "uncertain",
      ].sort(),
    );
  });

  it("publishes local instructions as a create, installs them and strips the local field", async () => {
    const f = await setup();
    const entry = await migrate(f.deps, f.side);
    expect(entry.status).toBe("confirmed");
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.content).toBe(body("Be brief."));
    expect(f.sent[0]?.tags).toContainEqual(["op", "create"]);
    expect(f.store.state(subject)).toMatchObject({ state: "present" });
    expect(f.store.hadVersion(subject)).toBe(true);
    expect(f.local.stripped).toBe(1);
  });

  it("publishes missing instructions as an explicit empty revision", async () => {
    const f = await setup();
    f.local.text = "";
    await migrate(f.deps, f.side);
    expect(f.sent[0]?.content).toBe(body(""));
    expect(f.store.instructions(subject)).toEqual({ ok: true, text: "" });
  });

  it("adopts another device's equal head without publishing", async () => {
    const f = await setup();
    f.state.head = await revision(body("Be brief."));
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({ status: "adopted" });
    expect(entry.draft).toBeUndefined();
    expect(f.sent).toHaveLength(0);
    expect(f.local.stripped).toBe(1);
  });

  it("keeps a byte-different local value as a draft when adopting", async () => {
    const f = await setup();
    f.state.head = await revision(body("Be brief. "));
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({
      status: "adopted",
      draft: body("Be brief."),
    });
    expect(f.local.stripped).toBe(0);
    expect(f.store.instructions(subject)).toEqual({
      ok: true,
      text: "Be brief. ",
    });
  });

  it("blocks on a deleted head and keeps the local value as a draft", async () => {
    const f = await setup();
    f.state.head = await revision("", "delete");
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({
      status: "blocked",
      draft: body("Be brief."),
    });
    expect(f.store.state(subject).state).toBe("deleted");
    expect(f.store.hadVersion(subject)).toBe(true);
  });

  it("installs an invalid head found by migration as invalid, never present", async () => {
    const f = await setup();
    f.state.head = await revision(body("x"), "create", "another-channel");
    const entry = await migrate(f.deps, f.side);
    expect(entry.status).toBe("blocked");
    expect(f.store.state(subject)).toMatchObject({
      state: "invalid",
      problem: "Artifact home mismatch",
    });
  });

  it("installs an invalid head read after its own publish as invalid, never present", async () => {
    const f = await setup(async () => {
      f.state.head = await revision(body("x"), "update", "another-channel");
    });
    const entry = await migrate(f.deps, f.side);
    expect(entry.status).toBe("superseded");
    expect(f.store.state(subject).state).toBe("invalid");
    expect(f.local.stripped).toBe(0);
  });

  it("resends the identical signed bytes after an uncertain send, across a restart", async () => {
    let lose = true;
    const f = await setup(() => {
      if (lose) throw new Error("socket closed");
    });
    expect((await migrate(f.deps, f.side)).status).toBe("uncertain");
    expect(f.local.stripped).toBe(0);
    lose = false;
    const restarted = {
      ...f.deps,
      store: new AgentConfigStore(f.storage),
      journal: new MigrationJournal(f.storage),
    };
    expect((await migrate(restarted, f.side)).status).toBe("confirmed");
    expect(f.writer.sign).toHaveBeenCalledTimes(1);
    expect(f.sent.map((e) => e.id)).toEqual([f.sent[0]?.id, f.sent[0]?.id]);
    expect(f.storage.getItem(MIGRATION_STORAGE_KEY)).toContain('"confirmed"');
  });

  it("records acceptance with no readable head as accepted-unavailable, never local", async () => {
    const f = await setup();
    f.state.readable = false;
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({
      status: "accepted-unavailable",
      draft: body("Be brief."),
      eventId: f.sent[0]?.id,
    });
    expect(MODE[entry.status]).toBe("synced");
    expect(f.store.hadVersion(subject)).toBe(true);
    expect(f.local.stripped).toBe(0);
    f.state.readable = true;
    expect((await migrate(f.deps, f.side)).status).toBe("confirmed");
    expect(f.sent).toHaveLength(1);
  });

  it("adopts the winner when its create is refused as identity-taken", async () => {
    const winner = await revision(body("From the other device"));
    const f = await setup(() => {
      f.state.head = winner;
      throw new PublishRejected("refused", "conflict: identity exists");
    });
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({
      status: "adopted",
      draft: body("Be brief."),
    });
    expect(f.store.state(subject).head?.id).toBe(winner.id);
  });

  it("fails on a definitive refusal and keeps the local value as the launch source", async () => {
    const f = await setup(() => {
      throw new PublishRejected("refused", "invalid: bad tag");
    });
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({
      status: "failed",
      error: "invalid: bad tag",
    });
    expect(MODE[entry.status]).toBe("migrating");
    expect(f.store.hadVersion(subject)).toBe(false);
    expect(f.local.stripped).toBe(0);
  });

  it("keeps an uncertain send uncertain when its resend is refused", async () => {
    let answer: () => void = () => {
      throw new Error("timeout");
    };
    const f = await setup(() => answer());
    await migrate(f.deps, f.side);
    answer = () => {
      throw new PublishRejected("refused", "conflict: newer head");
    };
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({
      status: "uncertain",
      draft: body("Be brief."),
    });
    expect(entry.signedEvent?.id).toBe(f.sent[0]?.id);
  });

  it("keeps a local edit made during migration as a draft", async () => {
    const f = await setup(() => {
      f.local.text = "Edited meanwhile";
    });
    const entry = await migrate(f.deps, f.side);
    expect(entry).toMatchObject({
      status: "confirmed",
      draft: body("Edited meanwhile"),
    });
    expect(f.local.stripped).toBe(0);
  });
});

describe("saves as revisions", () => {
  async function synced() {
    const f = await setup();
    await migrate(f.deps, f.side);
    const [first] = f.sent;
    if (!first) throw new Error("migration published nothing");
    return { ...f, first };
  }

  it("saves an edit as an update on the head the editor saw", async () => {
    const f = await synced();
    const result = await save(f.deps, f.side, body("Be kind."));
    expect(result.status).toBe("saved");
    expect(f.sent[1]?.tags).toContainEqual(["op", "update"]);
    expect(f.sent[1]?.tags).toContainEqual(["prev", f.first.id]);
    expect(f.store.instructions(subject)).toEqual({
      ok: true,
      text: "Be kind.",
    });
    expect(f.journal.unsaved(subject)).toBeUndefined();
  });

  it("publishes a first revision as a create when there is no head", async () => {
    const f = await setup();
    expect((await save(f.deps, f.side, body("New"))).status).toBe("saved");
    expect(f.sent[0]?.tags).toContainEqual(["op", "create"]);
    expect(f.store.state(subject).state).toBe("present");
  });

  it("keeps the edit as a draft on conflict and installs the newer head", async () => {
    const f = await synced();
    const newer = await revision(body("Elsewhere"), "update");
    f.writer.publish = async (event) => {
      f.sent.push(event);
      f.state.head = newer;
      throw new PublishRejected("refused", "conflict: stale prev");
    };
    const result = await save(f.deps, f.side, body("Mine"));
    expect(result).toMatchObject({
      status: "conflict",
      head: { id: newer.id },
    });
    expect(f.store.state(subject).head?.id).toBe(newer.id);
    expect(f.journal.unsaved(subject)).toBeUndefined();
  });

  it("installs an invalid head read after a save as invalid, never present", async () => {
    const f = await synced();
    const publish = f.writer.publish;
    f.writer.publish = async (event) => {
      await publish(event, f.deps.signal);
      f.state.head = await revision(body("x"), "update", "another-channel");
    };
    await save(f.deps, f.side, body("Mine"));
    expect(f.store.state(subject)).toMatchObject({
      state: "invalid",
      problem: "Artifact home mismatch",
    });
  });

  it("installs an invalid head read after a save conflict as invalid, never present", async () => {
    const f = await synced();
    const bad = await revision(body("x"), "update", "another-channel");
    f.writer.publish = async () => {
      f.state.head = bad;
      throw new PublishRejected("refused", "conflict: stale prev");
    };
    await save(f.deps, f.side, body("Mine"));
    expect(f.store.state(subject).state).toBe("invalid");
  });

  it("conflicts without sending when the editor opened an older head", async () => {
    const f = await synced();
    expect(
      (await save(f.deps, f.side, body("One"), undefined, f.first.id)).status,
    ).toBe("saved");
    const result = await save(
      f.deps,
      f.side,
      body("Two"),
      undefined,
      f.first.id,
    );
    expect(result).toMatchObject({
      status: "conflict",
      head: { id: f.sent[1]?.id },
    });
    expect(f.sent).toHaveLength(2);
  });

  it("keeps the head's unknown fields and tags on an edit", async () => {
    const f = await synced();
    const d = await artifactD(type, channel);
    const template = artifactTemplate({
      channel,
      type,
      d,
      op: "update",
      prev: f.first.id,
      title: "Agent instructions",
      content: JSON.stringify({ version: 1, text: "Old", future: 7 }),
      extra: [["client-tag", "kept"]],
    });
    const newer = await signed(owner, template);
    const publish = f.writer.publish;
    f.writer.publish = async () => {
      f.writer.publish = publish;
      f.state.head = newer;
      throw new PublishRejected("refused", "conflict: stale prev");
    };
    await save(f.deps, f.side, body("Lost"));
    expect(f.store.state(subject).head?.id).toBe(newer.id);
    const result = await save(f.deps, f.side, edited(newer, { text: "New" }));
    expect(result.status).toBe("saved");
    const last = f.sent.at(-1);
    expect(last?.tags).toContainEqual(["client-tag", "kept"]);
    expect(last?.tags).toContainEqual(["prev", newer.id]);
    expect(JSON.parse(last?.content ?? "")).toEqual({
      version: 1,
      text: "New",
      future: 7,
    });
  });

  it("keeps a save held for replay when another save of the subject runs at once", async () => {
    const f = await synced();
    f.writer.publish = async (event) => {
      f.sent.push(event);
      if (event.content === body("Mine")) throw new Error("socket closed");
      throw new PublishRejected("refused", "invalid: bad tag");
    };
    const [mine, other] = await Promise.all([
      save(f.deps, f.side, body("Mine")),
      save(f.deps, f.side, body("Other")),
    ]);
    expect(mine).toMatchObject({ status: "uncertain", retired: false });
    expect(other.status).toBe("uncertain");
    expect(f.journal.unsaved(subject)?.event.content).toBe(body("Mine"));
  });

  it("keeps a new save held when a reconnect resume of an older one runs at once", async () => {
    const f = await synced();
    f.writer.publish = async (event) => {
      f.sent.push(event);
      throw new Error("socket closed");
    };
    expect((await save(f.deps, f.side, body("Mine"))).status).toBe("uncertain");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The reconnect resend is refused late; any other is refused at once, and
    // the newer save stays uncertain.
    let resends = 0;
    f.writer.publish = async (event) => {
      f.sent.push(event);
      if (event.content !== body("Mine")) throw new Error("socket closed");
      if (resends++ === 0) await held;
      throw new PublishRejected("refused", "invalid: bad tag");
    };
    const resumed = resume(f.deps, f.side);
    const newer = save(f.deps, f.side, body("Newer"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await resumed;
    expect(await newer).toMatchObject({ status: "uncertain", retired: false });
    expect(f.journal.unsaved(subject)?.event.content).toBe(body("Newer"));
  });

  it("resends a save's identical bytes after an uncertain send, across a restart", async () => {
    const f = await synced();
    const publish = f.writer.publish;
    f.writer.publish = async (event) => {
      f.sent.push(event);
      throw new Error("socket closed");
    };
    expect((await save(f.deps, f.side, body("Mine"))).status).toBe("uncertain");
    // A later save first resends the held bytes; still unresolved, it stops.
    expect((await save(f.deps, f.side, body("Other"))).status).toBe(
      "uncertain",
    );
    expect(f.sent[2]?.id).toBe(f.sent[1]?.id);
    f.writer.publish = publish;
    const restarted = {
      ...f.deps,
      store: new AgentConfigStore(f.storage),
      journal: new MigrationJournal(f.storage),
    };
    expect((await resume(restarted, f.side))?.status).toBe("saved");
    expect(f.sent[3]?.id).toBe(f.sent[1]?.id);
    expect(restarted.journal.unsaved(subject)).toBeUndefined();
  });
});

it("serializes Save and History revise and recovers the queue after failed signing", async () => {
  const f = await setup();
  await migrate(f.deps, f.side);
  const head = f.store.state(subject).head;
  if (!head) throw new Error("no head");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sign = f.writer.sign;
  let signing = 0;
  f.writer.sign = vi.fn(async (template, signal) => {
    if (++signing === 1) {
      await held;
      throw new Error("sign failed");
    }
    return sign(template, signal);
  });
  const first = save(f.deps, f.side, body("FAIL"));
  const failure = expect(first).rejects.toThrow("sign failed");
  const second = revise(
    f.deps,
    f.side,
    artifactTemplate({
      ...f.side.expected,
      op: "update",
      prev: head.id,
      title: f.side.title,
      content: body("RESTORE"),
    }),
    head.id,
  );
  await vi.waitFor(() => expect(signing).toBe(1));
  release();
  await failure;
  expect((await second).status).toBe("saved");
  expect(f.journal.unsaved(subject)).toBeUndefined();
  expect(f.store.instructions(subject)).toEqual({ ok: true, text: "RESTORE" });
});
