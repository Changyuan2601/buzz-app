import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type EventTemplate,
} from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import type { AgentChoicesSnapshot } from "../agents/choices";
import { uuidv5 } from "../agents/agent-config-artifacts";
import { createChannelDetails } from "../relay/channel-details";
import type { ChannelDetails } from "../relay/channel-details-protocol";
import type { ChannelSummary, Profile } from "../relay/contracts";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { matchesEvent } from "../relay/projection";
import { PublishRejected, createOutbox } from "../relay/outbox";
import { createMessages } from "../relay/messages";
import { SOLO_LABEL } from "./labels";
import {
  createSoloPrimary,
  PRIMARY_LABEL,
  primaryTags,
  primaryPin,
  type PrimaryBinding,
} from "./primary";

const ownerKey = generateSecretKey(),
  otherKey = generateSecretKey();
const owner = getPublicKey(ownerKey),
  other = getPublicKey(otherKey);
const primary = "b".repeat(64),
  secondary = "c".repeat(64);
const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const sign = (template: EventTemplate, key = ownerKey) =>
  finalizeEvent(template, key) as RelayEvent;
const human = { pubkey: owner, source: "human" as const };
async function revision(binding: Partial<PrimaryBinding> = {}, prev?: string) {
  return sign({
    kind: 45010,
    created_at: 1,
    tags: [
      ["ar", "1"],
      ["h", channel],
      ["d", await uuidv5(channel, "buzz.solo.primary")],
      ["type", "buzz.solo.primary"],
      ["op", prev ? "update" : "create"],
      ...(prev ? [["prev", prev]] : []),
    ],
    content: JSON.stringify({
      version: 1,
      owner,
      identity: primary,
      mode: "automatic",
      defaults: "harness-default",
      ...binding,
    }),
  });
}
function fixture() {
  const life = new AbortController();
  let events: readonly RelayEvent[] = [];
  let admins: string[][] = [["p", owner, "owner"]];
  let adminProfiles: readonly RelayEvent[] = [];
  const history = new Map<string, RelayEvent>();
  let roster: ChannelSummary = {
    id: channel,
    name: "Chat",
    channelType: "solo",
    creator: owner,
    members: [owner, other, primary, secondary],
  };
  let metadata: ChannelDetails = {
    channelId: channel,
    version: "metadata",
    canEdit: true,
    name: "Chat",
    description: "",
    visibility: "private",
    labels: [SOLO_LABEL],
  };
  const identities = [primary, secondary].map((pubkey) => ({
    pubkey,
    name: pubkey.slice(0, 4),
    managed: false,
  }));
  let agents: AgentChoicesSnapshot = {
    status: "ready",
    identities,
    selectable: identities,
    definitions: [],
    complete: true,
    pending: false,
    archives: { status: "ready", archived: [] },
    templates: { status: "ready", identities, complete: true, pending: false },
  };
  const profiles = new Map<string, Profile>([[other, { name: "Person" }]]);
  const published: RelayEvent[] = [];
  const read = vi.fn(async (filters: readonly ReadFilter[]) => {
    const meta = sign({
      kind: 39000,
      created_at: 1,
      content: "",
      tags: [
        ["d", channel],
        ...(metadata.labels ?? []).map((value) => ["t", value]),
      ],
    });
    return [
      ...adminProfiles,
      ...(filters.some((filter) => filter.ids || filter.artifact === "history")
        ? history.values()
        : events),
      meta,
      sign({
        kind: 39001,
        created_at: 1,
        content: "",
        tags: [["d", channel], ...admins],
      }),
    ].filter((event) => filters.some((filter) => matchesEvent(event, filter)));
  });
  const writer = {
    sign: vi.fn(async (template: EventTemplate) => sign(template)),
    publish: vi.fn(async (event: RelayEvent) => {
      const prev = event.tags.find(([name]) => name === "prev")?.[1];
      if (prev && prev !== events[0]?.id)
        throw new PublishRejected("conflict: stale revision");
      published.push(event);
      events = [event];
      history.set(event.id, event);
    }),
  };
  const details = {
    available: true,
    load: vi.fn(async () => metadata),
    save: vi.fn(
      async (
        _base: ChannelDetails,
        draft: Omit<ChannelDetails, "version" | "channelId" | "canEdit">,
      ) => {
        metadata = { ...metadata, ...draft };
      },
    ),
    snapshot: vi.fn(() => undefined),
    check: vi.fn(async () => {}),
    subscribe: () => () => {},
  };
  const membership = vi.fn(async () => roster);
  const choices = {
    ensure: vi.fn(),
    refresh: vi.fn(async () => {}),
    snapshot: () => agents,
  };
  const deps = {
    viewer: owner,
    relayAuthor: owner,
    signal: life.signal,
    read,
    writer,
    details,
    membership,
    choices,
    profiles: { snapshot: () => profiles },
  };
  return {
    cap: createSoloPrimary(deps),
    deps,
    life,
    writer,
    published,
    details,
    read,
    membership,
    choices,
    setEvents: (value: readonly RelayEvent[], repin = true) => {
      events = value;
      history.clear();
      for (const event of value) history.set(event.id, event);
      if (repin && metadata.labels?.includes(PRIMARY_LABEL) && value[0])
        metadata = {
          ...metadata,
          labels: [
            ...metadata.labels.filter(
              (label) => !label.startsWith("buzz.solo.p:"),
            ),
            primaryPin(value[0].id),
          ],
        };
    },
    setHistory: (value: readonly RelayEvent[]) => {
      history.clear();
      for (const event of value) history.set(event.id, event);
    },
    setRoster: (value: Partial<ChannelSummary>) => {
      roster = { ...roster, ...value };
      if (value.creator) admins = [["p", value.creator, "owner"]];
    },
    setAdmins: (value: string[][]) => {
      admins = value;
    },
    setAdminProfiles: (value: readonly RelayEvent[]) => {
      adminProfiles = value;
    },
    clearMembers: () => {
      const next = { ...roster };
      delete next.members;
      roster = next;
    },
    setMetadata: (value: Partial<ChannelDetails>) => {
      metadata = { ...metadata, ...value };
      if (
        value.labels?.includes(PRIMARY_LABEL) &&
        !value.labels.some((label) => label.startsWith("buzz.solo.p:")) &&
        events[0]
      )
        metadata = {
          ...metadata,
          labels: [...value.labels, primaryPin(events[0].id)],
        };
    },
    setAgents: (value: Partial<AgentChoicesSnapshot>) => {
      agents = { ...agents, ...value };
    },
    message: (tags: string[][], key = ownerKey) =>
      sign(
        {
          kind: 9,
          created_at: 2,
          tags: [["h", channel], ...tags],
          content: "Hello",
        },
        key,
      ),
  };
}
async function adopted() {
  const f = fixture(),
    event = await revision();
  f.setEvents([event]);
  f.setMetadata({ labels: [SOLO_LABEL, PRIMARY_LABEL] });
  return { ...f, event };
}

describe("owner-authorized primary binding", () => {
  it("persists adoption before the binding, then conflict-checks subsequent edits", async () => {
    const f = fixture();
    f.writer.publish.mockImplementationOnce(async (event) => {
      expect((await f.details.load()).labels).toContain(PRIMARY_LABEL);
      f.published.push(event);
      f.setEvents([event], false);
    });
    const first = await f.cap.save(channel, {}, primary, "automatic");
    expect(first.binding).toEqual({
      version: 1,
      owner,
      identity: primary,
      mode: "automatic",
      defaults: "harness-default",
    });
    const second = await f.cap.save(channel, first, secondary, "mention-only");
    expect(second.binding?.identity).toBe(secondary);
    expect((await f.details.load()).labels).toContain(
      primaryPin(second.revision ?? ""),
    );
    await expect(
      f.cap.save(channel, first, primary, "automatic"),
    ).rejects.toThrow(/changed/);
    expect(f.published).toHaveLength(2);
    expect(f.details.save).toHaveBeenCalledTimes(3);
  });
  it("does not publish after failed marker adoption or resume automatic inference after interruption", async () => {
    const f = fixture();
    f.details.save.mockRejectedValueOnce(new Error("unconfirmed"));
    await expect(f.cap.save(channel, {}, primary, "automatic")).rejects.toThrow(
      /unconfirmed/,
    );
    expect(f.published).toHaveLength(0);
    f.setMetadata({ labels: [SOLO_LABEL, PRIMARY_LABEL] });
    expect(await f.cap.resolve(channel, [], human)).toMatchObject({
      recipients: [],
      notice: expect.stringMatching(/binding is missing/),
    });
  });
  it("rechecks conversion before signing after marker adoption", async () => {
    const f = fixture();
    f.details.save.mockImplementationOnce(async () => {
      f.setMetadata({ labels: [PRIMARY_LABEL] });
    });
    await expect(f.cap.save(channel, {}, primary, "automatic")).rejects.toThrow(
      /changed/,
    );
    expect(f.writer.sign).not.toHaveBeenCalled();
  });
  it("refuses a non-owner writer and a signer that is not the owner", async () => {
    const f = fixture();
    f.setRoster({ creator: other });
    await expect(f.cap.save(channel, {}, primary, "automatic")).rejects.toThrow(
      /Only the owner/,
    );
    f.setRoster({ creator: owner });
    f.writer.sign.mockImplementationOnce(async (template) =>
      sign(template, otherKey),
    );
    await expect(f.cap.save(channel, {}, primary, "automatic")).rejects.toThrow(
      /owner must sign/,
    );
    expect(f.published).toHaveLength(0);
  });
  it("surfaces a concurrent CAS refusal and an uncertain acceptance without replay", async () => {
    const f = fixture();
    f.writer.publish.mockRejectedValueOnce(
      new PublishRejected("conflict: changed"),
    );
    await expect(f.cap.save(channel, {}, primary, "automatic")).rejects.toThrow(
      /conflict/,
    );
    f.writer.publish.mockRejectedValueOnce(new Error("connection lost"));
    await expect(f.cap.save(channel, {}, primary, "automatic")).rejects.toThrow(
      /may have succeeded/,
    );
    expect(f.writer.publish).toHaveBeenCalledTimes(2);
  });
  it("does not publish settings altered by the signer", async () => {
    const f = fixture();
    f.writer.sign.mockImplementationOnce(async (template) =>
      sign({
        ...template,
        content: JSON.stringify({
          version: 1,
          owner,
          identity: secondary,
          mode: "automatic",
          defaults: "harness-default",
        }),
      }),
    );
    await expect(f.cap.save(channel, {}, primary, "automatic")).rejects.toThrow(
      /exact response settings/,
    );
    expect(f.published).toHaveLength(0);
  });
  it.each(["owner", "version", "mode", "envelope", "ambiguous", "deleted"])(
    "does not infer a primary from %s-invalid state",
    async (kind) => {
      const f = await adopted();
      if (kind === "owner")
        f.setEvents([sign({ ...f.event, content: f.event.content }, otherKey)]);
      if (kind === "mode")
        f.setEvents([
          await revision({ mode: ["automatic"] as unknown as "automatic" }),
        ]);
      if (kind === "version")
        f.setEvents([await revision({ version: 2 as 1 })]);
      if (kind === "envelope")
        f.setEvents([
          sign({ ...f.event, tags: [...f.event.tags, ["h", channel]] }),
        ]);
      if (kind === "ambiguous")
        f.setMetadata({
          labels: [
            SOLO_LABEL,
            PRIMARY_LABEL,
            primaryPin(f.event.id),
            primaryPin("f".repeat(64)),
          ],
        });
      if (kind === "deleted")
        f.setEvents([
          sign({
            ...f.event,
            content: "",
            tags: f.event.tags
              .filter(([name]) => name !== "op")
              .concat([
                ["op", "delete"],
                ["prev", f.event.id],
              ]),
          }),
        ]);
      expect(await f.cap.resolve(channel, [], human)).toMatchObject({
        recipients: [],
        notice: expect.any(String),
      });
      expect(f.published).toHaveLength(0);
    },
  );
});

describe("effective Solo recipients", () => {
  it("chooses the primary among multiple agents; explicit agent tags replace it and deduplicate", async () => {
    const f = await adopted();
    expect(await f.cap.resolve(channel, [], human)).toEqual({
      recipients: [primary],
      primary: {
        identity: primary,
        revision: f.event.id,
        targeting: "implicit",
      },
    });
    expect(await f.cap.resolve(channel, [secondary], human)).toEqual({
      recipients: [secondary],
    });
    expect(
      await f.cap.resolve(channel, [primary, secondary, primary], human),
    ).toEqual({
      recipients: [primary, secondary],
      primary: {
        identity: primary,
        revision: f.event.id,
        targeting: "explicit",
      },
    });
    expect((await f.cap.resolve(channel, [other], human)).recipients).toEqual([
      other,
      primary,
    ]);
  });
  it.each(["name-only", "agent-profile"])(
    "does not add the primary to a secondary-only tag with partial inventory and a %s",
    async (kind) => {
      const f = await adopted();
      const agents = f.choices.snapshot();
      f.setAgents({
        identities: agents.identities.filter(
          (agent) => agent.pubkey === primary,
        ),
        selectable: agents.selectable.filter(
          (agent) => agent.pubkey === primary,
        ),
        complete: false,
      });
      f.deps.profiles.snapshot().set(secondary, {
        name: "Secondary",
        ...(kind === "agent-profile" ? { isAgent: true } : {}),
      });
      const result = await f.cap.resolve(channel, [secondary], human);
      expect(result.recipients).toEqual([secondary]);
      expect(result.primary).toBeUndefined();
      if (kind === "name-only") expect(result.notice).toMatch(/still loading/);
    },
  );
  it("blocks guest and cross-session execution but keeps ordinary agent replies informational", async () => {
    const f = await adopted();
    for (const sender of [
      { pubkey: secondary, source: "cross-session" as const },
      { pubkey: owner, source: "cross-session" as const },
      { pubkey: other, source: "human" as const },
    ]) {
      if (sender.pubkey === other && sender.source === "human")
        expect(await f.cap.resolve(channel, [], sender)).toEqual({
          recipients: [],
        });
      else
        expect(await f.cap.resolve(channel, [], sender)).toMatchObject({
          recipients: [],
          notice: expect.stringMatching(/Only the chat owner/),
        });
      for (const recipients of [[primary], [primary, secondary]])
        expect(await f.cap.resolve(channel, recipients, sender)).toEqual({
          recipients,
          notice: expect.stringMatching(/Only the chat owner/),
        });
      expect(await f.cap.resolve(channel, [secondary], sender)).toEqual({
        recipients: [secondary],
      });
    }
    expect(
      await f.cap.resolve(channel, [], {
        pubkey: secondary,
        source: "agent-reply",
      }),
    ).toEqual({ recipients: [] });
    expect(
      await f.cap.resolve(channel, [primary], {
        pubkey: secondary,
        source: "agent-reply",
      }),
    ).toEqual({
      recipients: [primary],
      notice: expect.stringMatching(/Only the chat owner/),
    });
  });
  it("preserves authored recipients without inference before explicit adoption", async () => {
    const f = fixture();
    expect(await f.cap.resolve(channel, [], human)).toEqual({
      recipients: [],
      unadopted: true,
    });
    expect(await f.cap.resolve(channel, [primary], human)).toEqual({
      recipients: [primary],
      unadopted: true,
    });
    const guest = { pubkey: other, source: "human" as const };
    expect(await f.cap.resolve(channel, [secondary, secondary], guest)).toEqual(
      { recipients: [secondary], unadopted: true },
    );
    await f.cap.save(channel, {}, primary, "automatic");
    expect(await f.cap.resolve(channel, [], guest)).toEqual({ recipients: [] });
    expect(await f.cap.resolve(channel, [secondary], guest)).toEqual({
      recipients: [secondary],
    });
  });
  it("opts out of automatic responses but refuses missing adopted state", async () => {
    const f = await adopted();
    f.setEvents([await revision({ mode: "mention-only" })]);
    expect(await f.cap.resolve(channel, [], human)).toEqual({ recipients: [] });
    f.setEvents([]);
    expect(await f.cap.resolve(channel, [secondary], human)).toMatchObject({
      recipients: [secondary],
      notice: expect.stringMatching(/missing/),
    });
    expect(await f.cap.resolve(channel, [], human)).toMatchObject({
      recipients: [],
      notice: expect.stringMatching(/missing/),
    });
  });
  it.each([
    "missing",
    "cached",
    "removed",
    "archived",
    "unavailable",
    "unknown-archive",
  ])("refuses implicit delivery for %s participant evidence", async (kind) => {
    const f = await adopted();
    if (kind === "missing") f.clearMembers();
    if (kind === "cached") f.setRoster({ cached: true });
    if (kind === "removed") f.setRoster({ members: [owner, other, secondary] });
    if (kind === "archived") f.setRoster({ archived: true });
    if (kind === "unavailable") f.setAgents({ selectable: [] });
    if (kind === "unknown-archive")
      f.setAgents({ archives: { status: "error", archived: [] } });
    expect(await f.cap.resolve(channel, [], human)).toMatchObject({
      recipients: [],
      notice: expect.any(String),
    });
  });
});

describe("queued implicit admission", () => {
  it("preserves unadopted admission without requiring owner roster or editable details", async () => {
    const f = fixture();
    f.membership.mockRejectedValue(new Error("Owner roster unavailable"));
    f.details.load.mockRejectedValue(new Error("Not an editable channel"));
    expect(
      await f.cap.current(f.message([["p", primary, "", "mention"]]), primary),
    ).toBe(true);
    expect(await f.cap.resolve(channel, [primary], human)).toEqual({
      recipients: [primary],
      unadopted: true,
    });
    expect(f.membership).not.toHaveBeenCalled();
  });
  it("refuses a conversion completed while availability is being refreshed", async () => {
    const f = await adopted();
    const resolved = await f.cap.resolve(channel, [], human);
    let started!: () => void, release!: () => void;
    const refreshing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.choices.refresh.mockImplementationOnce(async () => {
      started();
      await gate;
    });
    const pending = f.cap.current(
      f.message([["p", primary], ...primaryTags(resolved.primary)]),
      primary,
    );
    try {
      await refreshing;
      f.setMetadata({ labels: [PRIMARY_LABEL] });
      f.setEvents([await revision({ mode: "mention-only" }, f.event.id)]);
    } finally {
      release();
    }
    expect(await pending).toBe(false);
  });
  it.each(["archived", "removed"])(
    "can carry an %s primary forward mention-only without making it executable",
    async (reason) => {
      const f = await adopted();
      const state = await f.cap.load(channel);
      f.setMetadata({ labels: [PRIMARY_LABEL] });
      if (reason === "archived") f.setAgents({ selectable: [] });
      else f.setRoster({ members: [owner, other, secondary] });
      const saved = await f.cap.save(channel, state, primary, "mention-only");
      expect(saved.binding).toEqual({ ...state.binding, mode: "mention-only" });
      expect(await f.cap.resolve(channel, [primary], human)).toMatchObject({
        recipients: [primary],
        notice: expect.stringMatching(/unavailable/),
      });
    },
  );
  it.each([
    "converted",
    "missing",
    "changed",
    "mention-only",
    "removed",
    "label-removed",
  ])("does not execute after the binding is %s", async (kind) => {
    const f = await adopted();
    const resolved = await f.cap.resolve(channel, [], human);
    const message = f.message([
      ["p", primary],
      ...primaryTags(resolved.primary),
    ]);
    expect(await f.cap.current(message, primary)).toBe(true);
    if (kind === "converted") f.setMetadata({ labels: [PRIMARY_LABEL] });
    if (kind === "missing") f.setEvents([]);
    if (kind === "label-removed") f.setMetadata({ labels: [SOLO_LABEL] });
    if (kind === "changed")
      f.setEvents([await revision({ identity: secondary }, f.event.id)]);
    if (kind === "mention-only")
      f.setEvents([await revision({ mode: "mention-only" }, f.event.id)]);
    if (kind === "removed") f.setRoster({ members: [owner, other, secondary] });
    if (kind === "removed")
      await expect(f.cap.current(message, primary)).rejects.toThrow(
        /unavailable/,
      );
    else if (["missing", "label-removed"].includes(kind))
      await expect(f.cap.current(message, primary)).rejects.toThrow(
        /restore the primary labels/,
      );
    else expect(await f.cap.current(message, primary)).toBe(false);
    if (kind === "converted") {
      expect(await f.cap.resolve(channel, [], human)).toEqual({
        recipients: [],
      });
      expect(
        await f.cap.resolve(channel, [], {
          pubkey: secondary,
          source: "cross-session",
        }),
      ).toEqual({ recipients: [] });
    }
    if (["changed", "missing", "label-removed"].includes(kind))
      await expect(
        f.cap.current(f.message([["p", primary]]), primary),
      ).rejects.toThrow(
        kind === "changed" ? /Set primary/ : /restore the primary labels/,
      );
    else
      expect(await f.cap.current(f.message([["p", primary]]), primary)).toBe(
        false,
      );
  });
  it("admits signed explicit owner targeting after conversion, but not ambiguous or forged targeting", async () => {
    const f = await adopted();
    const explicit = await f.cap.resolve(channel, [primary], human);
    const tags = [["p", primary], ...primaryTags(explicit.primary)];
    f.setMetadata({ labels: [PRIMARY_LABEL] });
    expect(await f.cap.current(f.message(tags), primary)).toBe(true);
    expect(await f.cap.current(f.message([["p", primary]]), primary)).toBe(
      false,
    );
    expect(
      await f.cap.current(
        f.message([
          ["p", primary],
          ["primary", primary, f.event.id],
        ]),
        primary,
      ),
    ).toBe(false);
    expect(
      await f.cap.current(
        f.message([...tags, ...primaryTags(explicit.primary)]),
        primary,
      ),
    ).toBe(false);
    expect(await f.cap.current(f.message(tags, otherKey), primary)).toBe(false);
    expect(
      await f.cap.current(
        f.message([
          ["p", primary],
          ["primary", secondary, f.event.id, "explicit"],
        ]),
        primary,
      ),
    ).toBe(false);
    expect(
      await f.cap.current(
        f.message([
          ["p", primary],
          ["primary", primary, f.event.id, "implicit"],
        ]),
        primary,
      ),
    ).toBe(false);
  });
  it("preserves unrelated legacy agents and carries an existing binding forward mention-only", async () => {
    const legacy = fixture();
    expect(
      await legacy.cap.current(legacy.message([["p", primary]]), primary),
    ).toBe(true);
    const f = await adopted();
    f.setMetadata({ labels: [PRIMARY_LABEL] });
    const state = await f.cap.load(channel);
    const saved = await f.cap.save(channel, state, primary, "mention-only");
    expect(saved.binding).toEqual({ ...state.binding, mode: "mention-only" });
    await expect(
      f.cap.save(channel, saved, primary, "automatic"),
    ).rejects.toThrow(/Only the owner/);
    expect(
      await f.cap.current(
        f.message([["p", secondary, "", "mention"]]),
        secondary,
      ),
    ).toBe(true);
  });
  it("denies a queued secondary removed during its final admission read", async () => {
    const f = await adopted();
    const event = f.message([["p", secondary, "", "mention"]]);
    expect(await f.cap.current(event, secondary)).toBe(true);
    const readMembership = f.membership.getMockImplementation();
    if (!readMembership) throw new Error("Missing fixture membership");
    f.membership
      .mockImplementationOnce(readMembership)
      .mockImplementationOnce(async () => {
        f.setRoster({ members: [owner, other, primary] });
        return readMembership();
      });
    expect(await f.cap.current(event, secondary)).toBe(false);
  });
  it("makes a replaced primary tag-only and denies missing adoption evidence", async () => {
    const f = await adopted();
    const next = await f.cap.save(
      channel,
      await f.cap.load(channel),
      secondary,
      "automatic",
    );
    const resolved = await f.cap.resolve(channel, [], human);
    expect(resolved.recipients).toEqual([secondary]);
    const event = f.message([
      ["p", secondary],
      ...primaryTags(resolved.primary),
    ]);
    expect(await f.cap.current(event, secondary)).toBe(true);
    expect(await f.cap.current(event, primary)).toBe(false);
    expect(
      await f.cap.current(f.message([["p", primary, "", "mention"]]), primary),
    ).toBe(true);
    f.setMetadata({ labels: [SOLO_LABEL] });
    expect(await f.cap.resolve(channel, [secondary], human)).toMatchObject({
      recipients: [secondary],
      notice: expect.stringMatching(/missing/),
    });
    await expect(
      f.cap.current(
        f.message([
          ["p", secondary],
          ["primary", secondary, next.revision ?? "", "explicit"],
        ]),
        secondary,
      ),
    ).rejects.toThrow(/restore the primary labels/);
  });
  it("refuses a late membership result after the owning session retires", async () => {
    const f = fixture();
    let release!: (channel: ChannelSummary) => void;
    const started = new Promise<ChannelSummary>((resolve) => {
      release = resolve;
    });
    f.membership.mockReturnValueOnce(started);
    const pending = f.cap.save(channel, {}, primary, "automatic");
    f.life.abort();
    release({
      id: channel,
      name: "Chat",
      creator: owner,
      members: [owner, primary],
    });
    await expect(pending).rejects.toThrow();
    expect(f.details.save).not.toHaveBeenCalled();
    expect(f.writer.sign).not.toHaveBeenCalled();
  });
});

describe("signed message integration", () => {
  it("posts the human message with a visible notice when an adopted binding is unknown", async () => {
    const f = await adopted();
    f.setEvents([]);
    const writer = {
      sign: async (template: EventTemplate) => sign({ ...template }),
      publish: vi.fn(async (_event: RelayEvent) => {}),
    };
    const { outbox, dispose } = createOutbox(owner, writer, {
      load: () => [],
      save: () => {},
    });
    try {
      await outbox.ready();
      const resolved = await f.cap.resolve(channel, [primary], human);
      expect(resolved).toMatchObject({
        recipients: [primary],
        notice: expect.stringMatching(/binding is missing/),
      });
      const messages = createMessages(
        outbox,
        owner,
        () => undefined,
        () => [],
        () => {},
      );
      messages.send(
        channel,
        "Still talking to the channel",
        resolved.recipients,
        [],
        undefined,
        [],
        {},
        [],
        { authored: [primary] },
      );
      await vi.waitFor(() => expect(writer.publish).toHaveBeenCalledOnce());
      const event = writer.publish.mock.calls[0]?.[0];
      if (!event) throw new Error("Message was not published");
      await expect(f.cap.current(event, primary)).rejects.toThrow(
        /restore the primary labels/,
      );
    } finally {
      dispose();
    }
  });

  it("rejects legacy inference published before adoption but admits signed authored secondaries", async () => {
    const f = fixture();
    const writer = {
      sign: async (template: EventTemplate) => sign({ ...template }),
      publish: vi.fn(async (_event: RelayEvent) => {}),
    };
    const { outbox, dispose } = createOutbox(owner, writer, {
      load: () => [],
      save: () => {},
    });
    try {
      await outbox.ready();
      const messages = createMessages(
        outbox,
        owner,
        () => undefined,
        () => [],
        () => {},
      );
      messages.send(channel, "Untagged before adoption", [primary]);
      messages.send(
        channel,
        "Authored before adoption",
        [primary],
        [],
        undefined,
        [],
        {},
        [],
        { authored: [primary] },
      );
      await vi.waitFor(() => expect(writer.publish).toHaveBeenCalledTimes(2));
      const [legacy, explicit] = writer.publish.mock.calls.map(
        ([event]) => event,
      );
      if (!legacy || !explicit) throw new Error("Messages not published");
      expect(await f.cap.current(legacy, primary)).toBe(true);
      await f.cap.save(channel, {}, secondary, "automatic");
      await expect(f.cap.current(legacy, primary)).rejects.toThrow(
        /updated client/,
      );
      expect(await f.cap.current(explicit, primary)).toBe(true);
      expect(writer.publish).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
    }
  });

  it.each(["send", "reply"] as const)(
    "binds %s targeting and per-recipient choices to the signed event",
    async (operation) => {
      const f = await adopted();
      const resolved = await f.cap.resolve(
        channel,
        [primary, secondary],
        human,
      );
      const writer = {
        sign: async (template: EventTemplate) => sign({ ...template }),
        publish: vi.fn(async (_event: RelayEvent) => {}),
      };
      const { outbox, dispose } = createOutbox(owner, writer, {
        load: () => [],
        save: () => {},
      });
      try {
        await outbox.ready();
        const messages = createMessages(
          outbox,
          owner,
          () => undefined,
          () => [],
          () => {},
        );
        const picks = { [secondary]: { model: "fast", effort: "low" } };
        if (operation === "send")
          messages.send(
            channel,
            "Hello",
            resolved.recipients,
            [],
            undefined,
            [],
            picks,
            [],
            { primary: resolved.primary, authored: [primary, secondary] },
          );
        else
          messages.reply(
            channel,
            "e".repeat(64),
            "Hello",
            resolved.recipients,
            [],
            undefined,
            [],
            picks,
            [],
            { primary: resolved.primary, authored: [primary, secondary] },
          );
        await vi.waitFor(() => expect(writer.publish).toHaveBeenCalledOnce());
        const event = writer.publish.mock.calls[0]?.[0];
        if (!event) throw new Error("Message was not published");
        expect(event.tags).toContainEqual([
          "primary",
          primary,
          f.event.id,
          "explicit",
        ]);
        expect(event.tags).toContainEqual(["model", secondary, "fast"]);
        expect(event.tags).toContainEqual(["effort", secondary, "low"]);
        expect(event.tags.filter(([name]) => name === "p")).toEqual([
          ["p", primary, "", "mention"],
          ["p", secondary, "", "mention"],
        ]);
        expect(await f.cap.current(event, primary)).toBe(true);
        expect(await f.cap.current(event, secondary)).toBe(true);
        expect(() =>
          messages.send(
            channel,
            "Hello",
            [secondary],
            [],
            undefined,
            [],
            {},
            [],
            { primary: resolved.primary },
          ),
        ).toThrow(/current recipient/);
      } finally {
        dispose();
      }
    },
  );
});

it("ignores foreign mutable heads without adopting legacy chats, and recovers a foreign pinned revision explicitly", async () => {
  const f = await adopted();
  const attack = sign(
    {
      ...f.event,
      content: f.event.content,
      tags: f.event.tags
        .filter(([name]) => name !== "op")
        .concat([
          ["op", "update"],
          ["prev", f.event.id],
        ]),
    },
    otherKey,
  );
  f.setEvents([attack, f.event], false);
  const current = await f.cap.resolve(channel, [], human);
  expect(current.primary?.revision).toBe(f.event.id);
  expect(
    await f.cap.current(
      f.message([["p", primary], ...primaryTags(current.primary)]),
      primary,
    ),
  ).toBe(true);
  const legacy = fixture();
  legacy.setEvents([attack]);
  expect(await legacy.cap.resolve(channel, [], human)).toEqual({
    recipients: [],
    unadopted: true,
  });
  f.setMetadata({ labels: [SOLO_LABEL, PRIMARY_LABEL, primaryPin(attack.id)] });
  expect(await f.cap.resolve(channel, [], human)).toMatchObject({
    recipients: [],
    notice: expect.stringMatching(/binding is missing/),
  });
  const repaired = await f.cap.save(
    channel,
    await f.cap.load(channel),
    secondary,
    "automatic",
  );
  expect(repaired.binding?.identity).toBe(secondary);
  expect((await f.cap.resolve(channel, [], human)).primary?.revision).toBe(
    repaired.revision,
  );
});

it("observes conversion after the last awaited binding read", async () => {
  const f = await adopted();
  const resolved = await f.cap.resolve(channel, [], human);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = f.read.getMockImplementation();
  if (!read) throw new Error("Missing fixture reader");
  let refreshed = false;
  f.choices.refresh.mockImplementation(async () => {
    refreshed = true;
  });
  f.read.mockImplementation(async (filters) => {
    const result = await read(filters);
    if (filters.some((filter) => filter.kinds?.includes(45010)) && refreshed) {
      refreshed = false;
      entered();
      await held;
    }
    return result;
  });
  const pending = f.cap.current(
    f.message([["p", primary], ...primaryTags(resolved.primary)]),
    primary,
  );
  try {
    await started;
    f.setMetadata({ labels: [PRIMARY_LABEL] });
  } finally {
    release();
  }
  expect(await pending).toBe(false);
});

it("converges two owner devices on the accepted pin without admitting unpublished or foreign revisions", async () => {
  const f = await adopted();
  let clock = 1;
  let enteredB!: () => void, releaseB!: () => void;
  const atB = new Promise<void>((resolve) => {
    enteredB = resolve;
  });
  const heldB = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  const owners: ReturnType<typeof createChannelDetails>[] = [];
  const metadata = async () => {
    const labels = (await f.details.load()).labels ?? [];
    return [
      sign({
        kind: 39000,
        created_at: clock,
        content: "",
        tags: [
          ["d", channel],
          ["name", "Chat"],
          ["t", "stream"],
          ["private"],
          ...labels.map((label) => ["t", label]),
        ],
      }),
      sign({
        kind: 39001,
        created_at: clock,
        content: "",
        tags: [
          ["d", channel],
          ["p", owner, "owner"],
        ],
      }),
      sign({
        kind: 39002,
        created_at: clock,
        content: "",
        tags: [
          ["d", channel],
          ["p", owner, "", "owner"],
        ],
      }),
    ];
  };
  const device = (second: boolean) => {
    const details = createChannelDetails({
      reader: { read: metadata },
      viewer: owner,
      relayAuthor: owner,
      labels: true,
      canAccess: () => true,
      acceptDiscovery: () => {},
      writer: {
        sign: f.writer.sign,
        publish: async (event) => {
          if (second) {
            enteredB();
            await heldB;
          } else await atB;
          f.setMetadata({
            labels: event.tags
              .filter(([name]) => name === "t")
              .map(([, value]) => value ?? ""),
          });
          clock++;
        },
      },
    });
    owners.push(details);
    return createSoloPrimary({ ...f.deps, details: details.capability });
  };
  const a = device(false),
    b = device(true);
  const initial = await a.load(channel);
  let drafts = 0;
  const publish = f.writer.publish.getMockImplementation();
  if (!publish) throw new Error("Missing fixture publisher");
  f.writer.publish.mockImplementation(async (event) => {
    await publish(event);
    const receipt = {
      identity: JSON.parse(event.content).identity as string,
      revision: event.id,
      targeting: "implicit" as const,
    };
    expect(
      await f.cap.current(
        f.message([["p", receipt.identity], ...primaryTags(receipt)]),
        receipt.identity,
      ),
    ).toBe(false);
    drafts++;
  });
  const first = a.save(channel, initial, secondary, "automatic");
  const second = b.save(channel, initial, primary, "mention-only");
  try {
    await atB;
    const savedA = await first;
    expect(drafts).toBe(2);
    expect((await a.load(channel)).revision).toBe(savedA.revision);
    releaseB();
    const savedB = await second;
    expect((await a.load(channel)).revision).toBe(savedB.revision);
    expect((await b.load(channel)).revision).toBe(savedB.revision);
    const old = f.message([
      ["p", secondary],
      ...primaryTags({
        identity: secondary,
        revision: savedA.revision ?? "",
        targeting: "implicit",
      }),
    ]);
    expect(await a.current(old, secondary)).toBe(false);
    expect(await a.resolve(channel, [], human)).toEqual({ recipients: [] });
  } finally {
    releaseB();
    await Promise.allSettled([first, second]);
    for (const owner of owners) owner.dispose();
  }
});

it("refuses ambiguous targeting when a non-primary becomes primary during admission", async () => {
  const f = await adopted();
  const replacement = await revision({ identity: secondary }, f.event.id);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = f.read.getMockImplementation();
  if (!read) throw new Error("Missing fixture reader");
  f.read.mockImplementationOnce(async (filters) => read(filters));
  f.read.mockImplementationOnce(async (filters) => {
    const result = await read(filters);
    entered();
    await held;
    return result;
  });
  const pending = f.cap.current(
    f.message([["p", secondary, "", "mention"]]),
    secondary,
  );
  try {
    await started;
    f.setEvents([replacement]);
  } finally {
    release();
  }
  expect(await pending).toBe(false);
});

it.each(
  [
    [
      ["h", channel],
      ["h", "11111111-1111-4111-8111-111111111111"],
    ],
    [["h", "bad-channel"]],
    [["h", "------------------------------------"]],
    [["h", channel, "unexpected"]],
    [["h"]],
  ].map((channels) => ({ channels })),
)(
  "refuses ambiguous or malformed channel targeting $channels",
  async ({ channels }) => {
    const f = await adopted();
    const event = sign(
      {
        kind: 9,
        created_at: 2,
        content: "Hello",
        tags: [...channels, ["p", primary]],
      },
      otherKey,
    );
    expect(await f.cap.current(event, primary)).toBe(false);
    const dm = sign({
      kind: 9,
      created_at: 2,
      content: "Hello",
      tags: [["p", primary]],
    });
    expect(await f.cap.current(dm, primary)).toBe(true);
  },
);

it("rejects an adoption exceeding the final label budget before writing its veto", async () => {
  const f = fixture();
  f.setMetadata({ labels: [SOLO_LABEL, "a", "b", "c", "d", "e", "f"] });
  await expect(f.cap.save(channel, {}, primary, "automatic")).rejects.toThrow(
    /at most 8/,
  );
  expect(f.details.save).not.toHaveBeenCalled();
  expect(f.writer.sign).not.toHaveBeenCalled();
});

it("does not replace the retained primary after conversion", async () => {
  const f = await adopted();
  const state = await f.cap.load(channel);
  f.setMetadata({ labels: [PRIMARY_LABEL] });
  await expect(
    f.cap.save(channel, state, secondary, "mention-only"),
  ).rejects.toThrow(/retain/);
  expect(f.published).toHaveLength(0);
  expect((await f.cap.load(channel)).binding?.identity).toBe(primary);
});

it.each(
  [
    [
      ["p", owner, "owner"],
      ["p", other, "admin"],
    ],
    [
      ["p", owner, "owner"],
      ["p", other, "owner"],
    ],
    [["p", owner, "admin"]],
    [["p", owner, "owner", "unexpected"]],
    [],
  ].map((roles) => ({ roles })),
)(
  "fails closed with unverified channel administrators: $roles",
  async ({ roles }) => {
    const f = await adopted();
    const resolved = await f.cap.resolve(channel, [], human);
    f.setAdmins(roles);
    expect(await f.cap.resolve(channel, [], human)).toMatchObject({
      recipients: [],
      notice: expect.stringMatching(/administrat/),
    });
    await expect(
      f.cap.current(
        f.message([["p", primary], ...primaryTags(resolved.primary)]),
        primary,
      ),
    ).rejects.toThrow(/administrat/);
    await expect(f.cap.load(channel)).rejects.toThrow(/administrat/);
    expect(f.published).toHaveLength(0);
  },
);

it.each(["admin", "owner"])(
  "admits an owner-managed agent administrator (%s) and refuses lost ownership evidence",
  async (role) => {
    const f = fixture();
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`nostr:agent-auth:${other}:`),
      ),
    );
    f.setAdminProfiles([
      sign(
        {
          kind: 0,
          created_at: 1,
          content: JSON.stringify({ is_agent: true }),
          tags: [
            ["auth", owner, "", bytesToHex(schnorr.sign(digest, ownerKey))],
          ],
        },
        otherKey,
      ),
    ]);
    f.setAdmins([
      ["p", owner, "owner"],
      ["p", other, role],
    ]);
    const state = await f.cap.save(channel, {}, primary, "automatic");
    expect((await f.cap.load(channel)).revision).toBe(state.revision);
    const resolved = await f.cap.resolve(channel, [], human);
    expect(resolved.recipients).toEqual([primary]);
    const message = f.message([
      ["p", primary],
      ...primaryTags(resolved.primary),
    ]);
    expect(await f.cap.current(message, primary)).toBe(true);
    f.setAdminProfiles([]);
    await expect(f.cap.load(channel)).rejects.toThrow(/administrat/);
    expect(await f.cap.resolve(channel, [], human)).toMatchObject({
      recipients: [],
      notice: expect.stringMatching(/administrat/),
    });
    await expect(f.cap.current(message, primary)).rejects.toThrow(
      /administrat/,
    );
    await expect(
      f.cap.save(channel, state, primary, "mention-only"),
    ).rejects.toThrow(/administrat/);
    expect(f.published).toHaveLength(1);
  },
);

it.each(["present", "soft-deleted"])(
  "remembers adoption in a fresh session after stale labels lose a %s binding",
  async (kind) => {
    const f = await adopted();
    if (kind === "soft-deleted")
      f.setEvents([
        sign({
          ...f.event,
          content: "",
          tags: f.event.tags
            .filter(([name]) => name !== "op")
            .concat([
              ["op", "delete"],
              ["prev", f.event.id],
            ]),
        }),
      ]);
    f.setMetadata({ labels: [SOLO_LABEL] });
    const fresh = createSoloPrimary(f.deps);
    expect(await fresh.load(channel)).toEqual({ adopted: true });
    await expect(
      fresh.current(f.message([["p", primary]]), primary),
    ).rejects.toThrow(/restore the primary labels/);
    expect(await fresh.resolve(channel, [], human)).toMatchObject({
      recipients: [],
      notice: expect.stringMatching(/binding is missing/),
    });
    expect(await fresh.resolve(channel, [secondary], human)).toMatchObject({
      recipients: [secondary],
      notice: expect.stringMatching(/binding is missing/),
    });
  },
);

it.each(["marker", "pin", "history"])(
  "retains the session adoption veto after %s evidence is completely removed",
  async (evidence) => {
    const f = await adopted();
    if (evidence !== "history") f.setEvents([]);
    f.setMetadata({
      labels:
        evidence === "marker"
          ? [PRIMARY_LABEL]
          : evidence === "pin"
            ? [primaryPin(f.event.id)]
            : [],
    });
    const fresh = createSoloPrimary(f.deps);
    expect(await fresh.load(channel)).toMatchObject({ adopted: true });
    f.setMetadata({ labels: [] });
    f.setEvents([]);
    await expect(
      fresh.current(f.message([["p", primary]]), primary),
    ).rejects.toThrow(/restore the primary labels/);
    expect(
      await createSoloPrimary(f.deps).current(
        f.message([["p", primary]]),
        primary,
      ),
    ).toBe(true);
  },
);

it("keeps humans and verifiable secondary mentions writable when primary authority is lost", async () => {
  const f = await adopted();
  f.setAdmins([
    ["p", owner, "owner"],
    ["p", other, "admin"],
  ]);
  expect(await f.cap.resolve(channel, [], human)).toMatchObject({
    recipients: [],
    notice: expect.stringMatching(/administrat/),
  });
  expect(await f.cap.resolve(channel, [secondary], human)).toEqual({
    recipients: [secondary],
  });
  expect(
    await f.cap.current(
      f.message([["p", secondary, "", "mention"]]),
      secondary,
    ),
  ).toBe(true);
  f.setMetadata({ labels: [PRIMARY_LABEL] });
  expect(await f.cap.resolve(channel, [other], human)).toEqual({
    recipients: [other],
  });
  expect(await f.cap.resolve(channel, [], human)).toEqual({ recipients: [] });
});

it("does not treat another member's artifact as adoption evidence", async () => {
  const f = fixture();
  f.setEvents([sign(await revision(), otherKey)]);
  expect(await f.cap.load(channel)).toEqual({});
  expect(await f.cap.current(f.message([["p", primary]]), primary)).toBe(true);
});

it.each(["update", "delete", "move"])(
  "vetoes fresh legacy admission after a non-owner %s hides the owner artifact",
  async (op) => {
    const f = await adopted();
    const hidden = sign(
      {
        ...f.event,
        content: op === "delete" ? "" : f.event.content,
        tags: f.event.tags
          .filter(([name]) => name !== "op")
          .concat([
            ["op", op],
            ["prev", f.event.id],
          ]),
      },
      otherKey,
    );
    const removal = sign({
      kind: 45011,
      created_at: 2,
      content: "",
      tags: [
        ["ar", "1"],
        ["h", channel],
        ["d", f.event.tags.find(([name]) => name === "d")?.[1] ?? ""],
        ["prev", f.event.id],
        ["reason", "moved"],
      ],
    });
    f.setEvents(op === "move" ? [removal] : [hidden], false);
    f.setHistory([f.event, hidden]);
    f.setMetadata({ labels: [SOLO_LABEL] });
    const fresh = createSoloPrimary(f.deps);
    expect(await fresh.load(channel)).toEqual({ adopted: true });
    await expect(
      fresh.current(f.message([["p", primary]]), primary),
    ).rejects.toThrow(/restore the primary labels/);
  },
);

it.each(["heads", "history"])(
  "denies missing-label inference when the %s bound is full",
  async (kind) => {
    const f = await adopted();
    const events = Array.from({ length: 64 }, (_, created_at) =>
      sign({ ...f.event, created_at, content: f.event.content }, otherKey),
    );
    f.setEvents(kind === "heads" ? events : events.slice(0, 1), false);
    f.setHistory(events);
    f.setMetadata({ labels: [SOLO_LABEL] });
    await expect(createSoloPrimary(f.deps).load(channel)).rejects.toThrow(
      /restore its primary labels in channel settings/i,
    );
  },
);
