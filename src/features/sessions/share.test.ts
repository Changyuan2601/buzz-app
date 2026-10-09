import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, metadata, profile, roster, signed } from "../relay/testing";
import { matchesEvent } from "../relay/projection";
import type { RelayEvent } from "../relay/events";
import { beginSessionShare, finishSessionShare } from "./share-attempt";
import { PublishRejected } from "../relay/outbox";
import {
  destinationShareAudience,
  grantSessionAccess,
  publishSessionLink,
  sessionLinkMessage,
} from "./share";

const sessionId = "11111111-1111-4111-8111-111111111111";
const channelId = "22222222-2222-4222-8222-222222222222";
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup() {
  const viewer = keypair(),
    relay = keypair(),
    human = keypair(),
    bot = keypair(),
    late = keypair();
  const published: RelayEvent[] = [];
  const members = new Map([
    [sessionId, [viewer.pubkey]],
    [channelId, [viewer.pubkey]],
  ]);
  let clock = 1_700_000_000;
  let failLink = false;
  let rejectGrant = false;
  let records: readonly import("../relay/outbox").OutgoingEvent[] = [];
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9000 && rejectGrant)
      throw new PublishRejected("Invite denied");
    if (event.kind === 9 && failLink) throw new PublishRejected("Post denied");
    if (event.kind === 9000) {
      const id = event.tags.find(([tag]) => tag === "h")?.[1] ?? "";
      members.set(id, [
        ...new Set([
          ...(members.get(id) ?? []),
          event.tags.find(([tag]) => tag === "p")?.[1] ?? "",
        ]),
      ]);
    }
    published.push(event);
    clock++;
  });
  const query = vi.fn(
    async (filters: readonly import("../relay/events").ReadFilter[]) => {
      const events = [
        metadata(relay, sessionId, "Work", 1_700_000_000, [
          ["t", "stream"],
          ["private"],
          ["about", "Buzz session (buzz.sessions/v1)"],
        ]),
        metadata(relay, channelId, "Planning", 1_700_000_000, [
          ["t", "stream"],
          ["private"],
        ]),
        ...[sessionId, channelId].map((id) =>
          roster(relay, id, members.get(id) ?? [], clock),
        ),
        profile(human, { name: "Ari" }),
        ...published,
      ];
      return events.filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      );
    },
  );
  let knownAgent = false;
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://community.test",
      archiveAuthority: relay.pubkey,
      readAgentLibrary: async () => ({
        definitions: [],
        identities: knownAgent ? [{ pubkey: bot.pubkey, name: "Agent" }] : [],
      }),
      media: () => undefined,
      query,
      writer: {
        kinds: [9, 9000, 9007],
        sign: async (template) => signed(viewer, template),
        publish: async (event) => {
          await publish(event);
        },
      },
    },
    {
      outboxStorage: {
        load: () => records,
        save: (value) => {
          records = structuredClone(value);
        },
      },
    },
  );
  owners.push(owner);
  return {
    session: owner.session,
    observe: (event: RelayEvent) =>
      owner.session.read([{ ids: [event.id], limit: 1 }]),
    viewer,
    human,
    bot,
    late,
    members,
    addDestination(key: string) {
      members.set(channelId, [
        ...new Set([...(members.get(channelId) ?? []), key]),
      ]);
      clock++;
    },
    publish,
    query,
    records: () => records,
    published,
    failLink: (value: boolean) => {
      failLink = value;
    },
    setAgent: async () => {
      knownAgent = true;
      await owner.session.agentChoices.refresh();
    },
    async archive(key: string) {
      const archive = signed(relay, {
        kind: 13535,
        content: "",
        tags: [["-"], ["p", key]],
      });
      query.mockImplementationOnce(async () => [archive]);
      await owner.session.archives.refresh();
    },
    rejectGrant: (value: boolean) => {
      rejectGrant = value;
    },
    removeViewer: () => {
      members.set(sessionId, []);
      clock++;
    },
    async ready() {
      owner.session.channels.ensureList();
      await vi.waitFor(() =>
        expect(owner.session.channels.list().channels).toHaveLength(2),
      );
    },
  };
}

it("grants exact session membership, confirms its signed roster, then posts one ordinary channel link", async () => {
  const t = setup();
  await t.ready();
  const confirmed: string[] = [];
  await grantSessionAccess(
    t.session,
    sessionId,
    [t.human.pubkey],
    new Map(),
    new AbortController().signal,
    (key) => confirmed.push(key),
  );
  expect(confirmed).toEqual([t.human.pubkey]);
  expect(t.members.get(sessionId)).toContain(t.human.pubkey);
  expect(t.members.get(channelId)).not.toContain(t.human.pubkey);
  const id = await publishSessionLink(
    t.session,
    sessionId,
    channelId,
    undefined,
    new AbortController().signal,
    () => {},
  );
  expect(id).toMatch(/^[a-f0-9]{64}$/);
  expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
  expect(t.published[0]?.tags).toContainEqual(["h", sessionId]);
  expect(t.published[0]?.tags).toContainEqual(["p", t.human.pubkey]);
  expect(t.published[0]?.tags.some(([name]) => name === "role")).toBe(false);
  expect(t.published[1]?.tags).toEqual(
    expect.arrayContaining([["h", channelId]]),
  );
  expect(t.published[1]?.content).toBe(sessionLinkMessage(sessionId));
});

it("Everyone snapshots the destination's signed roster including agents, freezes it for retry, and only grants access", async () => {
  const t = setup();
  await t.ready();
  await t.setAgent();
  t.addDestination(t.human.pubkey);
  t.addDestination(t.bot.pubkey);
  const frozen = await destinationShareAudience(
    t.session,
    channelId,
    new AbortController().signal,
  );
  expect(frozen).toEqual([t.bot.pubkey, t.human.pubkey].sort());
  t.addDestination(t.late.pubkey);
  const confirmed: string[] = [];
  await grantSessionAccess(
    t.session,
    sessionId,
    frozen,
    new Map(),
    new AbortController().signal,
    (key) => confirmed.push(key),
    true,
  );
  expect(confirmed).toEqual(frozen);
  expect(t.members.get(sessionId)).toEqual(
    expect.arrayContaining([t.viewer.pubkey, t.human.pubkey, t.bot.pubkey]),
  );
  expect(t.members.get(sessionId)).not.toContain(t.late.pubkey);
  expect(t.published).toHaveLength(2);
  expect(t.published.map((event) => event.kind)).toEqual([9000, 9000]);
  expect(
    t.published.find((event) =>
      event.tags.some(([name, key]) => name === "p" && key === t.bot.pubkey),
    )?.tags,
  ).toContainEqual(["role", "bot"]);
  expect(
    t.published
      .find((event) =>
        event.tags.some(
          ([name, key]) => name === "p" && key === t.human.pubkey,
        ),
      )
      ?.tags.some(([name]) => name === "role"),
  ).toBe(false);
  expect(
    t.published.every((event) =>
      event.tags.some(([name, id]) => name === "h" && id === sessionId),
    ),
  ).toBe(true);
});

it("Everyone refuses missing fresh roster evidence instead of granting from the cached list", async () => {
  const t = setup();
  await t.ready();
  t.query.mockImplementationOnce(async () => []);
  await expect(
    destinationShareAudience(
      t.session,
      channelId,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/could not be confirmed/);
  expect(t.published).toHaveLength(0);
});

it("Everyone blocks a known-archived destination identity rather than silently dropping it", async () => {
  const t = setup();
  await t.ready();
  t.addDestination(t.bot.pubkey);
  await t.archive(t.bot.pubkey);
  expect(t.session.archives.state(t.bot.pubkey)).toBe("archived");
  await expect(
    destinationShareAudience(
      t.session,
      channelId,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/archived/);
  expect(t.published).toHaveLength(0);
});

it("does not publish on failed grant, nor duplicate an accepted grant or rejected link on retry", async () => {
  const t = setup();
  await t.ready();
  t.rejectGrant(true);
  const intents = new Map();
  await expect(
    grantSessionAccess(
      t.session,
      sessionId,
      [t.human.pubkey],
      intents,
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow();
  expect(t.published).toHaveLength(0);
  t.rejectGrant(false);
  await grantSessionAccess(
    t.session,
    sessionId,
    [t.human.pubkey],
    intents,
    new AbortController().signal,
    () => {},
  );
  t.failLink(true);
  let queued: string | undefined;
  await expect(
    publishSessionLink(
      t.session,
      sessionId,
      channelId,
      queued,
      new AbortController().signal,
      (id) => {
        queued = id;
      },
    ),
  ).rejects.toThrow("Post denied");
  t.failLink(false);
  await publishSessionLink(
    t.session,
    sessionId,
    channelId,
    queued,
    new AbortController().signal,
    () => {},
  );
  expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
  expect(t.records().filter((item) => item.event.kind === 9)).toHaveLength(1);
});

it("recognizes a real signed echo before publisher return and releases its saved recovery", async () => {
  const t = setup();
  await t.ready();
  let echo = false;
  t.publish.mockImplementationOnce(async (event) => {
    expect(event.kind).toBe(9);
    t.published.push(event);
    // A relay echo wins the delivery race, moving the event from pending to completed.
    await t.observe(event);
    expect(
      t.session.outbox?.snapshot().find((item) => item.event.id === event.id),
    ).toMatchObject({ delivery: "seen" });
    echo = true;
  });
  const id = await publishSessionLink(
    t.session,
    sessionId,
    channelId,
    undefined,
    new AbortController().signal,
    () => {},
  );
  expect(echo).toBe(true);
  expect(t.published.filter((event) => event.kind === 9)).toHaveLength(1);
  expect(
    t.session.outbox?.snapshot().find((item) => item.event.id === id),
  ).toBeUndefined();
  expect(
    t.records().find((item) => item.event.id === id)?.recovery,
  ).toBeUndefined();
});

it("reconciles a retired link receipt by exact ID, and fences missing evidence without another post", async () => {
  const t = setup();
  await t.ready();
  let id = "";
  await publishSessionLink(
    t.session,
    sessionId,
    channelId,
    undefined,
    new AbortController().signal,
    (value) => {
      id = value;
    },
  );
  expect(id).not.toBe("");
  await t.session.outbox?.dismiss(id);
  await expect(
    publishSessionLink(
      t.session,
      sessionId,
      channelId,
      id,
      new AbortController().signal,
      () => {},
    ),
  ).resolves.toBe(id);
  expect(t.published.filter((event) => event.kind === 9)).toHaveLength(1);
  await expect(
    publishSessionLink(
      t.session,
      sessionId,
      channelId,
      "f".repeat(64),
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow(/unconfirmed/);
  expect(t.published.filter((event) => event.kind === 9)).toHaveLength(1);
});

it("refuses a known agent and prevents posting after loss of session membership", async () => {
  const t = setup();
  await t.ready();
  // Known agent classification is an admission rule, not a name-based distinction.
  await t.setAgent();
  await expect(
    grantSessionAccess(
      t.session,
      sessionId,
      [t.bot.pubkey],
      new Map(),
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow(/agent picker/);
  expect(t.published).toHaveLength(0);
  t.removeViewer();
  await expect(
    publishSessionLink(
      t.session,
      sessionId,
      channelId,
      undefined,
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow(/access changed|membership/);
  expect(t.published).toHaveLength(0);
});

it.each(["accepted", "unknown"] as const)(
  "a missing %s Share grant receipt never authorizes another invitation",
  async (delivery) => {
    const t = setup();
    await t.ready();
    const outbox = t.session.outbox;
    if (!outbox) throw new Error("Missing outbox");
    const event = signed(t.viewer, {
      kind: 9000,
      content: "",
      tags: [
        ["h", sessionId],
        ["p", t.human.pubkey],
      ],
    });
    // Inject loss of receipt evidence, not a user dismissal. The real Outbox
    // disallows dismissing these states; absence must remain fail-closed too.
    let receipts: ReturnType<typeof outbox.snapshot> = [{ event, delivery }];
    const subscribers = new Set<() => void>();
    const session = {
      ...t.session,
      outbox: {
        ...outbox,
        snapshot: () => receipts,
        subscribe(listener: () => void) {
          subscribers.add(listener);
          return () => {
            subscribers.delete(listener);
          };
        },
      },
    };
    const resumed = beginSessionShare(session, sessionId, {
      destination: channelId,
      audience: "selected",
      channelPeople: [],
      sessionPeople: [t.human.pubkey],
    });
    resumed.grants.set(t.human.pubkey, { id: event.id });
    for (const listener of subscribers) listener();
    receipts = [];
    for (const listener of subscribers) listener();
    try {
      await expect(
        grantSessionAccess(
          t.session,
          sessionId,
          [t.human.pubkey],
          resumed.grants,
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow("original addition receipt is unavailable");
      expect(resumed.grants.get(t.human.pubkey)?.dismissed).not.toBe(true);
      expect(t.publish).not.toHaveBeenCalled();
    } finally {
      finishSessionShare(session, sessionId);
      expect(subscribers.size).toBe(0);
    }
  },
);
