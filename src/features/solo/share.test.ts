import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, metadata, profile, roster, signed } from "../relay/testing";
import { matchesEvent } from "../relay/projection";
import type { RelayEvent } from "../relay/events";
import { beginSoloShare, finishSoloShare } from "./share-attempt";
import { PublishRejected } from "../relay/outbox";
import { SHARED_SESSION_TOPIC } from "../sessions/shared-session-marker";
import { SOLO_NAMED_LABEL } from "./labels";
import {
  destinationShareAudience,
  grantSoloChatAccess,
  publishSoloChatLink,
  soloChatLinkMessage,
  isSoloChatLinkReceipt,
} from "./share";

const chatId = "11111111-1111-4111-8111-111111111111";
const channelId = "22222222-2222-4222-8222-222222222222";
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
/** `batch`: the relay adds every `p` it names, as batch-capable relays do;
 * otherwise only the first, as older relays do. */
function setup({ batch = false } = {}) {
  const viewer = keypair(),
    relay = keypair(),
    human = keypair(),
    bot = keypair(),
    late = keypair();
  const published: RelayEvent[] = [];
  const members = new Map([
    [chatId, [viewer.pubkey]],
    [channelId, [viewer.pubkey]],
  ]);
  let clock = 1_700_000_000;
  let failLink = false;
  let chosenName: string | undefined;
  let rejectGrant: boolean | string = false;
  let batchGate: Promise<void> | undefined;
  let failNextRoster = false;
  let failRoster = false;
  let records: readonly import("../relay/outbox").OutgoingEvent[] = [];
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.tags.filter(([tag]) => tag === "p").length > 1) await batchGate;
    const people = event.tags
      .filter(([tag]) => tag === "p")
      .map(([, key]) => key ?? "")
      .slice(0, batch ? undefined : 1);
    const allowed = people.filter((key) => key !== rejectGrant);
    if (event.kind === 9000 && (rejectGrant === true || !allowed.length))
      throw new PublishRejected("Invite denied");
    if (event.kind === 9 && failLink) throw new PublishRejected("Post denied");
    if (event.kind === 9000) {
      const id = event.tags.find(([tag]) => tag === "h")?.[1] ?? "";
      members.set(id, [...new Set([...(members.get(id) ?? []), ...allowed])]);
    }
    published.push(event);
    clock++;
    if (event.kind === 9000 && failNextRoster) {
      failNextRoster = false;
      failRoster = true;
    }
  });
  const query = vi.fn(
    async (filters: readonly import("../relay/events").ReadFilter[]) => {
      if (
        failRoster &&
        filters.some(
          (filter) =>
            filter.kinds?.includes(39002) && filter["#d"]?.includes(chatId),
        )
      ) {
        failRoster = false;
        throw new Error("Relay unavailable");
      }
      const events = [
        metadata(relay, chatId, chosenName ?? "Work", clock, [
          ["t", "stream"],
          ...(chosenName ? [["t", SOLO_NAMED_LABEL]] : []),
          ["private"],
          ["t", "buzz.solo"],
        ]),
        metadata(relay, channelId, "Planning", 1_700_000_000, [
          ["t", "stream"],
          ["private"],
        ]),
        ...[chatId, channelId].map((id) =>
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
  let moreAgents: string[] = [];
  const owner = createRelaySession(
    {
      channelIdentity: true,
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://community.test",
      archiveAuthority: relay.pubkey,
      readAgentLibrary: async () => ({
        definitions: [],
        identities: knownAgent
          ? [bot.pubkey, ...moreAgents].map((pubkey) => ({
              pubkey,
              name: "Agent",
            }))
          : [],
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
    async chooseName(name: string) {
      chosenName = name;
      clock++;
      await owner.session.read(
        [
          {
            kinds: [39000],
            authors: [relay.pubkey],
            "#d": [chatId],
            limit: 1,
          },
        ],
        { fresh: true },
      );
    },
    failLink: (value: boolean) => {
      failLink = value;
    },
    setAgent: async (more: string[] = []) => {
      knownAgent = true;
      moreAgents = more;
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
    holdBatch(gate: Promise<void>) {
      batchGate = gate;
    },
    failRosterAfterAdd() {
      failNextRoster = true;
    },
    rejectGrant: (value: boolean | string) => {
      rejectGrant = value;
    },
    removeViewer: () => {
      members.set(chatId, []);
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

it("grants exact Solo chat membership, confirms its signed roster, then posts one ordinary channel link", async () => {
  const t = setup();
  await t.ready();
  const confirmed: string[] = [];
  await grantSoloChatAccess(
    t.session,
    chatId,
    [t.human.pubkey],
    new Map(),
    new AbortController().signal,
    (key) => confirmed.push(key),
  );
  expect(confirmed).toEqual([t.human.pubkey]);
  expect(t.members.get(chatId)).toContain(t.human.pubkey);
  expect(t.members.get(channelId)).not.toContain(t.human.pubkey);
  const id = await publishSoloChatLink(
    t.session,
    chatId,
    channelId,
    undefined,
    new AbortController().signal,
    () => {},
  );
  expect(id).toMatch(/^[a-f0-9]{64}$/);
  expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
  expect(t.published[0]?.tags).toContainEqual(["h", chatId]);
  expect(t.published[0]?.tags).toContainEqual(["p", t.human.pubkey]);
  expect(t.published[0]?.tags.some(([name]) => name === "role")).toBe(false);
  expect(t.published[1]?.tags).toEqual(
    expect.arrayContaining([
      ["h", channelId],
      ["t", SHARED_SESSION_TOPIC],
      ["s", chatId],
    ]),
  );
  // An unnamed chat's starting title names the card.
  expect(t.published[1]?.content).toBe(soloChatLinkMessage(chatId, "Work"));
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
  await grantSoloChatAccess(
    t.session,
    chatId,
    frozen,
    new Map(),
    new AbortController().signal,
    (key) => confirmed.push(key),
    true,
  );
  expect([...confirmed].sort()).toEqual(frozen);
  expect(t.members.get(chatId)).toEqual(
    expect.arrayContaining([t.viewer.pubkey, t.human.pubkey, t.bot.pubkey]),
  );
  expect(t.members.get(chatId)).not.toContain(t.late.pubkey);
  // This relay adds only the batch's first person; the agent falls back to a single add.
  expect(t.published).toHaveLength(2);
  expect(t.published.map((event) => event.kind)).toEqual([9000, 9000]);
  expect(
    t.published[0]?.tags.filter(([name]) => name === "p" || name === "role"),
  ).toEqual([
    ["p", t.human.pubkey],
    ["p", t.bot.pubkey, "bot"],
  ]);
  expect(
    t.published[1]?.tags.filter(([name]) => name === "p" || name === "role"),
  ).toEqual([
    ["p", t.bot.pubkey],
    ["role", "bot"],
  ]);
  expect(
    t.published.every((event) =>
      event.tags.some(([name, id]) => name === "h" && id === chatId),
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

it.each([false, true])(
  "channel sharing skips archived members and still grants/posts without cleaning the roster (archived after capture=%s)",
  async (afterCapture) => {
    const t = setup();
    await t.ready();
    t.addDestination(t.bot.pubkey);
    t.addDestination(t.human.pubkey);
    if (!afterCapture) await t.archive(t.bot.pubkey);
    const audience = await destinationShareAudience(
      t.session,
      channelId,
      new AbortController().signal,
    );
    if (afterCapture) await t.archive(t.bot.pubkey);
    else expect(audience).toEqual([t.human.pubkey]);
    const confirmed: string[] = [];
    await grantSoloChatAccess(
      t.session,
      chatId,
      audience,
      new Map(),
      new AbortController().signal,
      (key) => confirmed.push(key),
      true,
      true,
      true,
    );
    await publishSoloChatLink(
      t.session,
      chatId,
      channelId,
      undefined,
      new AbortController().signal,
      () => {},
    );
    expect(confirmed).toEqual([t.human.pubkey]);
    expect(t.members.get(chatId)).toContain(t.human.pubkey);
    expect(t.members.get(chatId)).not.toContain(t.bot.pubkey);
    expect(t.members.get(channelId)).toContain(t.bot.pubkey);
    expect(t.session.archives.state(t.bot.pubkey)).toBe("archived");
    expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
  },
);

it("does not publish on failed grant, nor duplicate an accepted grant or rejected link on retry", async () => {
  const t = setup();
  await t.ready();
  await t.chooseName("PR_45 & <fix>");
  t.rejectGrant(true);
  const intents = new Map();
  expect(
    await grantSoloChatAccess(
      t.session,
      chatId,
      [t.human.pubkey],
      intents,
      new AbortController().signal,
      () => {},
    ),
  ).toEqual([{ key: t.human.pubkey, error: expect.any(String) }]);
  expect(t.published).toHaveLength(0);
  t.rejectGrant(false);
  await grantSoloChatAccess(
    t.session,
    chatId,
    [t.human.pubkey],
    intents,
    new AbortController().signal,
    () => {},
  );
  t.failLink(true);
  let queued: string | undefined;
  await expect(
    publishSoloChatLink(
      t.session,
      chatId,
      channelId,
      queued,
      new AbortController().signal,
      (id) => {
        queued = id;
      },
    ),
  ).rejects.toThrow("Post denied");
  const saved = t.records().find((item) => item.event.id === queued);
  expect(saved?.event.content).toBe(
    soloChatLinkMessage(chatId, "PR_45 & <fix>"),
  );
  expect(saved && isSoloChatLinkReceipt(saved)).toBe(true);
  await t.chooseName("A different chosen name");
  t.failLink(false);
  await publishSoloChatLink(
    t.session,
    chatId,
    channelId,
    queued,
    new AbortController().signal,
    () => {},
  );
  expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
  if (!saved) throw new Error("Missing saved receipt");
  expect(t.published[1]).toMatchObject(saved.event);
  expect(t.published[1]?.tags).toContainEqual(["t", SHARED_SESSION_TOPIC]);
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
  const id = await publishSoloChatLink(
    t.session,
    chatId,
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
  await publishSoloChatLink(
    t.session,
    chatId,
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
    publishSoloChatLink(
      t.session,
      chatId,
      channelId,
      id,
      new AbortController().signal,
      () => {},
    ),
  ).resolves.toBe(id);
  expect(t.published.filter((event) => event.kind === 9)).toHaveLength(1);
  await expect(
    publishSoloChatLink(
      t.session,
      chatId,
      channelId,
      "f".repeat(64),
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow(/unconfirmed/);
  expect(t.published.filter((event) => event.kind === 9)).toHaveLength(1);
});

it("tries everyone and returns per-person failures instead of throwing", async () => {
  const t = setup();
  await t.ready();
  t.rejectGrant(t.human.pubkey);
  const confirmed: string[] = [];
  expect(
    await grantSoloChatAccess(
      t.session,
      chatId,
      [t.human.pubkey, t.late.pubkey],
      new Map(),
      new AbortController().signal,
      (key) => confirmed.push(key),
    ),
  ).toEqual([{ key: t.human.pubkey, error: expect.any(String) }]);
  expect(confirmed).toEqual([t.late.pubkey]);
  expect(t.members.get(chatId)).toContain(t.late.pubkey);
  expect(t.members.get(chatId)).not.toContain(t.human.pubkey);
});

it("stops instead of trying the rest once the viewer can no longer add anyone", async () => {
  const t = setup();
  await t.ready();
  t.removeViewer();
  await expect(
    grantSoloChatAccess(
      t.session,
      chatId,
      [t.human.pubkey, t.late.pubkey],
      new Map(),
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow("This channel cannot add members");
  expect(t.publish).not.toHaveBeenCalled();
});

it("refuses a known agent and prevents posting after loss of chat membership", async () => {
  const t = setup();
  await t.ready();
  // Known agent classification is an admission rule, not a name-based distinction.
  await t.setAgent();
  expect(
    await grantSoloChatAccess(
      t.session,
      chatId,
      [t.bot.pubkey],
      new Map(),
      new AbortController().signal,
      () => {},
    ),
  ).toEqual([
    { key: t.bot.pubkey, error: expect.stringMatching(/tagging them/) },
  ]);
  expect(t.published).toHaveLength(0);
  t.removeViewer();
  await expect(
    publishSoloChatLink(
      t.session,
      chatId,
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
        ["h", chatId],
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
    const resumed = beginSoloShare(session, chatId, {
      destination: channelId,
      chatPeople: [t.human.pubkey],
    });
    resumed.grants.set(t.human.pubkey, { id: event.id });
    for (const listener of subscribers) listener();
    receipts = [];
    for (const listener of subscribers) listener();
    try {
      expect(
        await grantSoloChatAccess(
          t.session,
          chatId,
          [t.human.pubkey],
          resumed.grants,
          new AbortController().signal,
          () => {},
        ),
      ).toEqual([
        {
          key: t.human.pubkey,
          error: expect.stringContaining(
            "original addition receipt is unavailable",
          ),
        },
      ]);
      expect(resumed.grants.get(t.human.pubkey)?.dismissed).not.toBe(true);
      expect(t.publish).not.toHaveBeenCalled();
    } finally {
      finishSoloShare(session, chatId);
      expect(subscribers.size).toBe(0);
    }
  },
);

it("retries an older plain-link receipt without upgrading its signed share intent", async () => {
  const t = setup();
  await t.ready();
  t.failLink(true);
  const id = t.session.messages.send(
    channelId,
    soloChatLinkMessage(chatId),
    [],
    [],
  );
  await vi.waitFor(() =>
    expect(
      t.session.outbox?.snapshot().find((item) => item.event.id === id)
        ?.delivery,
    ).toBe("failed"),
  );
  const original = t.records().find((item) => item.event.id === id)?.event;
  if (!original) throw new Error("Missing original receipt");
  expect(original?.tags.some(([key]) => key === "s")).toBe(false);
  expect(original?.tags).not.toContainEqual(["t", SHARED_SESSION_TOPIC]);
  t.failLink(false);
  await expect(
    publishSoloChatLink(
      t.session,
      chatId,
      channelId,
      id,
      new AbortController().signal,
      () => {},
    ),
  ).resolves.toBe(id);
  expect(t.published).toHaveLength(1);
  expect(t.published[0]).toMatchObject(original);
});

it.each(["huddle", "metadataPending"] as const)(
  "rejects %s share destinations at the owner",
  async (flag) => {
    const t = setup();
    await t.ready();
    const list = t.session.channels.list();
    const session = {
      ...t.session,
      channels: {
        ...t.session.channels,
        refreshRoster: async () => true,
        list: () => ({
          ...list,
          channels: list.channels.map((c) =>
            c.id === channelId ? { ...c, [flag]: true } : c,
          ),
        }),
      },
    };
    await expect(
      destinationShareAudience(
        session,
        channelId,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Destination membership");
  },
);

it("adds everyone in one event when the relay takes several people", async () => {
  const t = setup({ batch: true });
  await t.ready();
  await t.setAgent();
  const confirmed: string[] = [];
  expect(
    await grantSoloChatAccess(
      t.session,
      chatId,
      [t.bot.pubkey, t.human.pubkey, t.late.pubkey],
      new Map(),
      new AbortController().signal,
      (key) => confirmed.push(key),
      true,
    ),
  ).toEqual([]);
  expect(confirmed).toEqual([t.human.pubkey, t.late.pubkey, t.bot.pubkey]);
  expect(t.published).toHaveLength(1);
  // Humans first and no event-wide role, so an older relay adds a human as a member.
  expect(
    t.published[0]?.tags.filter(([name]) => name === "p" || name === "role"),
  ).toEqual([
    ["p", t.human.pubkey],
    ["p", t.late.pubkey],
    ["p", t.bot.pubkey, "bot"],
  ]);
  // Settled additions leave nothing pending in Outbox.
  expect(t.session.outbox?.snapshot()).toEqual([]);
});

it("gives a batch of only agents the event-wide bot role", async () => {
  const t = setup({ batch: true });
  await t.ready();
  await t.setAgent([t.late.pubkey]);
  await grantSoloChatAccess(
    t.session,
    chatId,
    [t.bot.pubkey, t.late.pubkey],
    new Map(),
    new AbortController().signal,
    () => {},
    true,
  );
  // An older relay reads only this, and adds only the first agent.
  expect(
    t.published[0]?.tags.filter(([name]) => name === "p" || name === "role"),
  ).toEqual([
    ["p", t.bot.pubkey, "bot"],
    ["p", t.late.pubkey, "bot"],
    ["role", "bot"],
  ]);
});

it("retries only the people a batch missed, one at a time, and reports why", async () => {
  const t = setup({ batch: true });
  await t.ready();
  t.rejectGrant(t.human.pubkey);
  const confirmed: string[] = [];
  expect(
    await grantSoloChatAccess(
      t.session,
      chatId,
      [t.human.pubkey, t.late.pubkey],
      new Map(),
      new AbortController().signal,
      (key) => confirmed.push(key),
    ),
  ).toEqual([{ key: t.human.pubkey, error: expect.any(String) }]);
  expect(confirmed).toEqual([t.late.pubkey]);
  expect(
    t.published.map((event) =>
      event.tags.filter(([name]) => name === "p").map(([, key]) => key),
    ),
  ).toEqual([[t.human.pubkey, t.late.pubkey]]);
  expect(t.publish).toHaveBeenCalledTimes(2);
  expect(t.publish.mock.calls[1]?.[0].tags).toContainEqual([
    "p",
    t.human.pubkey,
  ]);
});

it("a failed roster read after a batch leaves the rest to single adds instead of failing the share", async () => {
  const t = setup({ batch: true });
  await t.ready();
  t.failRosterAfterAdd();
  const confirmed: string[] = [];
  expect(
    await grantSoloChatAccess(
      t.session,
      chatId,
      [t.human.pubkey, t.late.pubkey],
      new Map(),
      new AbortController().signal,
      (key) => confirmed.push(key),
    ),
  ).toEqual([]);
  expect(confirmed).toEqual([t.human.pubkey, t.late.pubkey]);
  // The batch added both; the single path found them on the roster without sending again.
  expect(t.published).toHaveLength(1);
});

it("a single add never resumes another share's batch still in flight", async () => {
  const t = setup({ batch: true });
  await t.ready();
  let release = () => {};
  t.holdBatch(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const batch = grantSoloChatAccess(
    t.session,
    chatId,
    [t.human.pubkey, t.late.pubkey],
    new Map(),
    new AbortController().signal,
    () => {},
  );
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledTimes(1));
  try {
    expect(
      await grantSoloChatAccess(
        t.session,
        chatId,
        [t.human.pubkey],
        new Map(),
        new AbortController().signal,
        () => {},
      ),
    ).toEqual([]);
    expect(t.published.at(-1)?.tags).toContainEqual(["p", t.human.pubkey]);
  } finally {
    release();
  }
  expect(await batch).toEqual([]);
  expect(t.members.get(chatId)).toEqual(
    expect.arrayContaining([t.human.pubkey, t.late.pubkey]),
  );
  expect(t.session.outbox?.snapshot()).toEqual([]);
});
