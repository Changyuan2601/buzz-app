import { applySessionSetup } from "../sessions/workspace";
import { createMePreferences } from "./me-preferences";
import { TEAM_MANIFEST_TAG } from "../channel-templates/team-payload";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import {
  coordinate,
  KIT_TAG,
  ME_KIT_TAG,
  kitTag,
  kitRecordFits,
  parseKitRecord,
  type Groups,
  type KitRecord,
} from "../channel-templates/model";
import { matchesEvent } from "./projection";
import { flush, keypair, roster, scriptedTransport, signed } from "./testing";
import type { ReadFilter, RelayEvent } from "./events";
import type { SidebarPreferences } from "./sidebar-preferences";

afterEach(() => vi.restoreAllMocks());

const channel = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const community = "https://primary.example";
const groups: Groups = {
  type: "groups",
  id: "personal",
  groups: [
    { id: "work", name: "Personal work", defaultTemplateId: "template" },
  ],
  assignments: { [other]: "work" },
};
function fixture(personal = true) {
  const viewer = keypair(),
    relay = keypair();
  let time = 1_700_000_000;
  let now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
  const events: RelayEvent[] = [];
  let legacy: SidebarPreferences = {
    sections: [{ id: "work", name: "OG work", icon: "★", order: 0 }],
    assignments: { [channel]: "work" },
    starred: [],
    muted: [],
  };
  const install = (value: Groups, deleted = false) => {
    const record: KitRecord = { version: 1, community, deleted, value };
    events.push(
      signed(viewer, {
        kind: 30078,
        created_at: time++,
        tags: [
          ["d", coordinate(record)],
          ["t", kitTag(record)],
        ],
        content: JSON.stringify(record),
      }),
    );
  };
  if (personal) install(structuredClone(groups));
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    events.filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    ),
  );
  const assignment = vi.fn(async (intent) => {
    const assignments = { ...legacy.assignments };
    if (intent.sectionId) assignments[intent.channelId] = intent.sectionId;
    else delete assignments[intent.channelId];
    legacy = { ...legacy, assignments };
    return legacy;
  });
  const star = vi.fn(async ({ channelId, starred }) => {
    legacy = { ...legacy, starred: starred ? [channelId] : [] };
    return legacy.starred;
  });
  const publish = vi.fn(async (event: RelayEvent) => {
    events.push(event);
  });
  const prepare = vi.fn(async (record: KitRecord, _signal: AbortSignal) =>
    JSON.stringify(record),
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: community,
      media: () => undefined,
      query,
      decodeSidebarPreferences: async () => legacy,
      writeSidebarAssignment: assignment,
      removeSidebarSection: async (id) => {
        legacy = {
          ...legacy,
          sections: legacy.sections.filter((section) => section.id !== id),
          assignments: Object.fromEntries(
            Object.entries(legacy.assignments).filter(
              ([, section]) => section !== id,
            ),
          ),
        };
        return legacy;
      },
      writeSidebarStar: star,
      channelKit: {
        decode: async (rows) =>
          rows.map((event) => ({
            eventId: event.id,
            record: JSON.parse(event.content),
          })),
        prepare,
      },
      writer: {
        kinds: [30078],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    { outboxStorage: { load: async () => [], save: async () => {} } },
  );
  return {
    ...owner,
    query,
    assignment,
    star,
    publish,
    prepare,
    install,
    events,
    preferences: owner.session.sidebarPreferences,
  };
}

it("routes moves/create to opted-in personal groups, preserves defaults and never writes hidden OG groups", async () => {
  const f = fixture();
  try {
    await f.preferences.ensure();
    expect(f.preferences.snapshot().data).toEqual({
      sections: [{ id: "work", name: "Personal work", order: 0 }],
      assignments: { [other]: "work" },
      starred: [],
      groupSource: "personal",
      muted: [],
    });
    const move = f.preferences.assign(channel, "work");
    expect(f.preferences.snapshot().data?.assignments[channel]).toBe("work");
    await move;
    await f.preferences.createAndAssign(channel, { id: "new", name: " New " });
    const event = f.publish.mock.calls.at(-1)?.[0];
    if (!event) throw new Error("Missing personal-group publication");
    const saved = JSON.parse(event.content).value;
    expect(saved.groups).toEqual([
      ...groups.groups,
      { id: "new", name: "New", defaultTemplateId: "" },
    ]);
    expect(saved.assignments).toEqual({ [other]: "work", [channel]: "new" });
    expect(f.assignment).not.toHaveBeenCalled();
    await f.preferences.setStar(channel, true);
    expect(f.preferences.snapshot().data?.starred).toEqual([channel]);
    await f.preferences.setStar(channel, false);
    expect(f.preferences.snapshot().data?.assignments[channel]).toBeUndefined();
    expect(f.preferences.snapshot().data?.starred).toEqual([]);
    expect(f.assignment).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it("retains OG routing before opt-in and refreshes displayed groups after activation and deletion", async () => {
  const f = fixture(false);
  try {
    await f.preferences.ensure();
    await f.preferences.assign(channel);
    expect(f.assignment).toHaveBeenCalledOnce();
    expect(f.publish).not.toHaveBeenCalled();
    f.install(groups);
    await f.session.channelKit.refresh();
    await f.preferences.refresh();
    expect(f.preferences.snapshot().data?.groupSource).toBe("personal");
    f.install(groups, true);
    await f.session.channelKit.refresh();
    await f.preferences.refresh();
    expect(f.preferences.snapshot().data?.groupSource).toBeUndefined();
    expect(f.preferences.snapshot().data?.sections[0]?.icon).toBe("★");
  } finally {
    f.dispose();
  }
});

it("rejects stale-source moves even when group IDs match, then refreshes without silently retrying into the other store", async () => {
  const f = fixture(false);
  try {
    await f.preferences.ensure();
    f.install(groups);
    await expect(f.preferences.assign(channel, "work")).rejects.toThrow(
      /source changed/,
    );
    await f.preferences.refresh();
    expect(f.preferences.snapshot().data?.groupSource).toBe("personal");
    await expect(f.preferences.retryMove(channel)).rejects.toThrow(
      /source changed/,
    );
    expect(f.assignment).not.toHaveBeenCalled();
    expect(f.star).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it.each(["cancel", "clear"] as const)(
  "%s fences an in-progress personal-group preparation before outbox enqueue",
  async (action) => {
    const f = fixture();
    const controller = new AbortController();
    let reached!: (signal: AbortSignal) => void;
    const entered = new Promise<AbortSignal>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await f.preferences.ensure();
      f.prepare.mockImplementationOnce(async (record, signal) => {
        reached(signal);
        await gate;
        return JSON.stringify(record);
      });
      const moving = f.preferences.assign(channel, "work", controller.signal);
      const rejected = expect(moving).rejects.toMatchObject({
        name: "AbortError",
      });
      const signal = await entered;
      if (action === "clear") await f.clearCache();
      else controller.abort();
      expect(signal.aborted).toBe(true);
      release();
      await rejected;
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.star).not.toHaveBeenCalled();
      expect(f.session.outbox?.snapshot()).toEqual([]);
    } finally {
      release();
      f.dispose();
    }
  },
);

it("preserves the personal schema limits and restores placement after a failed catalog read or save", async () => {
  const f = fixture();
  try {
    await f.preferences.ensure();
    await expect(
      f.preferences.createAndAssign(channel, {
        id: "new",
        name: "x".repeat(121),
      }),
    ).rejects.toThrow(/recipe text/);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.preferences.snapshot().data?.sections).toHaveLength(1);
    f.query.mockRejectedValueOnce(new Error("offline"));
    await expect(f.preferences.assign(channel, "work")).rejects.toThrow(
      /offline/,
    );
    expect(f.assignment).not.toHaveBeenCalled();
    expect(f.star).not.toHaveBeenCalled();
    expect(f.preferences.snapshot().data?.assignments[channel]).toBeUndefined();
    await f.preferences.retryMove(channel);
    expect(f.preferences.snapshot().data?.assignments[channel]).toBe("work");
    expect(f.preferences.snapshot().moves).toBeUndefined();
  } finally {
    f.dispose();
  }
});

it("retries a personal catalog read cancelled by initial roster authority", async () => {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    channelKit: { decode: async () => [], prepare: async () => "" },
  });
  try {
    const catalog = owner.session.channelKit.refresh();
    await flush();
    const interrupted = wire.next();
    expect(interrupted.filters[0]?.["#t"]).toEqual([
      KIT_TAG,
      TEAM_MANIFEST_TAG,
      ME_KIT_TAG,
    ]);
    owner.session.channels.ensureList();
    await flush();
    wire.next().respond([roster(relay, channel, [viewer.pubkey])]);
    await flush();
    expect(interrupted.signal?.aborted).toBe(true);
    const retry = wire.pending.find((entry) => entry.filters[0]?.["#t"]);
    expect(retry?.filters).toEqual(interrupted.filters);
    for (const entry of wire.pending.splice(0)) entry.respond([]);
    await catalog;
    expect(owner.session.channelKit.snapshot().status).toBe("ready");
  } finally {
    owner.dispose();
  }
});

it.each(["clearCache", "dispose"] as const)(
  "does not retry a personal catalog read cancelled by %s",
  async (action) => {
    const wire = scriptedTransport(keypair().pubkey, keypair().pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      channelKit: { decode: async () => [], prepare: async () => "" },
    });
    try {
      const catalog = owner.session.channelKit.refresh();
      await flush();
      const interrupted = wire.next();
      owner[action]();
      await catalog;
      await flush();
      expect(interrupted.signal?.aborted).toBe(true);
      expect(wire.pending).toHaveLength(0);
    } finally {
      owner.dispose();
    }
  },
);

it("removes active personal groups without altering legacy groups or channel membership", async () => {
  const h = fixture();
  await h.session.sidebarPreferences.ensure();
  expect(h.session.sidebarPreferences.snapshot().data?.groupSource).toBe(
    "personal",
  );
  await h.session.sidebarPreferences.removeSection("work");
  expect(h.session.sidebarPreferences.snapshot().data?.sections).toEqual([]);
  expect(h.session.sidebarPreferences.snapshot().data?.assignments).toEqual({});
  expect(h.assignment).not.toHaveBeenCalled();
  h.dispose();
});

it("rejects section deletion when another device changes the active group source", async () => {
  const h = fixture(false);
  try {
    await h.preferences.ensure();
    h.install(structuredClone(groups));
    await expect(h.preferences.removeSection("work")).rejects.toThrow(
      "active group source changed",
    );
    expect(h.publish).not.toHaveBeenCalled();
    await h.preferences.refresh();
    expect(h.preferences.snapshot().data?.sections).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

it("starts Me empty and changes only the distinct Me catalog coordinate", async () => {
  const f = fixture();
  const controller = new AbortController();
  const me = createMePreferences(f.session.channelKit, controller.signal);
  try {
    await me.queries.ensure();
    expect(me.queries.snapshot().data?.sections).toEqual([]);
    await me.queries.createAndAssign(channel, { id: "work", name: "Me work" });
    expect(me.queries.snapshot().data?.assignments).toEqual({
      [channel]: "work",
    });
    expect(me.queries.starWritable).toBe(false);
    const writes = f.publish.mock.calls.map(([event]) => event);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.tags).toContainEqual(["t", ME_KIT_TAG]);
    expect(
      writes[0] &&
        matchesEvent(writes[0], {
          "#t": [KIT_TAG, TEAM_MANIFEST_TAG],
          limit: 500,
        }),
    ).toBe(false);
    await f.preferences.ensure();
    expect(f.preferences.snapshot().data?.sections[0]?.name).toBe(
      "Personal work",
    );
    await me.queries.removeSection("work");
    expect(me.queries.snapshot().data?.sections).toEqual([]);
    expect(f.star).not.toHaveBeenCalled();
    expect(f.assignment).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    me.dispose();
    f.dispose();
  }
});

it("retains Me tombstone revision and never creates over an unread catalog", async () => {
  const f = fixture();
  f.install({ type: "groups", id: "me", groups: [], assignments: {} }, true);
  const controller = new AbortController();
  const me = createMePreferences(f.session.channelKit, controller.signal);
  try {
    await expect(
      me.queries.createAndAssign(channel, { id: "new", name: "New" }),
    ).rejects.toThrow();
    expect(f.publish).not.toHaveBeenCalled();
    await me.queries.ensure();
    await me.queries.createAndAssign(channel, { id: "new", name: "New" });
    expect(me.queries.snapshot().data?.sections[0]?.name).toBe("New");
  } finally {
    controller.abort();
    me.dispose();
    f.dispose();
  }
});

it("invalidates the session-owned Me projection on refreshed heads, including tombstones", async () => {
  const f = fixture();
  const me = f.session.mePreferences;
  const value: Groups = {
    type: "groups",
    id: "me",
    groups: [{ id: "work", name: "Me work", defaultTemplateId: "" }],
    assignments: { [channel]: "work" },
  };
  try {
    await me.ensure();
    await f.preferences.ensure();
    expect(me.snapshot().data?.sections).toEqual([]);
    f.install(value);
    await f.session.channelKit.refresh();
    await vi.waitFor(() =>
      expect(me.snapshot().data?.sections[0]?.name).toBe("Me work"),
    );
    f.install({
      ...value,
      groups: [
        { id: "work", defaultTemplateId: "", name: "Renamed elsewhere" },
      ],
    });
    await f.session.channelKit.refresh();
    await vi.waitFor(() =>
      expect(me.snapshot().data?.sections[0]?.name).toBe("Renamed elsewhere"),
    );
    f.install(value, true);
    await f.session.channelKit.refresh();
    await vi.waitFor(() => {
      expect(me.snapshot().data?.sections).toEqual([]);
      expect(me.snapshot().data?.assignments).toEqual({});
    });
    expect(f.preferences.snapshot().data?.sections[0]?.name).toBe(
      "Personal work",
    );
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.assignment).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it("round-trips independent Me placement and preserves it through group removal", async () => {
  const f = fixture();
  try {
    await f.session.mePlacement.set(channel, true);
    expect(f.session.mePlacement.has(channel)).toBe(true);
    await f.session.mePreferences.ensure();
    await f.session.mePreferences.createAndAssign(channel, {
      id: "g",
      name: "Work",
    });
    await f.session.mePreferences.removeSection("g");
    expect(f.session.mePlacement.has(channel)).toBe(true);
    await f.session.mePlacement.set(other, true);
    await f.session.mePlacement.set(channel, false);
    expect(f.session.mePlacement.has(channel)).toBe(false);
    expect(f.session.mePlacement.has(other)).toBe(true);
    expect(
      JSON.parse(f.publish.mock.calls.at(-1)?.[0].content ?? "null").value
        .channels,
    ).toEqual([other]);
    expect(f.publish.mock.calls.every(([event]) => event.kind === 30078)).toBe(
      true,
    );
    expect(f.assignment).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it("does not overwrite Me placement when a refresh fails, and reconciles retries against the fresh head", async () => {
  const f = fixture();
  try {
    f.install({
      type: "groups",
      id: "me",
      groups: [],
      assignments: {},
      channels: [other],
    });
    await f.session.mePlacement.refresh();
    f.query.mockRejectedValueOnce(new Error("offline"));
    await expect(f.session.mePlacement.set(channel, true)).rejects.toThrow();
    expect(f.publish).not.toHaveBeenCalled();
    await f.session.mePlacement.set(channel, true);
    expect(f.session.mePlacement.has(other)).toBe(true);
    expect(f.session.mePlacement.has(channel)).toBe(true);
    const count = f.publish.mock.calls.length;
    await f.session.mePlacement.set(channel, true);
    expect(f.publish).toHaveBeenCalledTimes(count);
  } finally {
    f.dispose();
  }
});

it("serializes simultaneous Me placement and group edits without losing either", async () => {
  const f = fixture();
  try {
    await f.session.mePreferences.ensure();
    await Promise.all([
      f.session.mePlacement.set(channel, true),
      f.session.mePreferences.createAndAssign(channel, {
        id: "g",
        name: "Work",
      }),
    ]);
    expect(f.session.mePlacement.has(channel)).toBe(true);
    expect(f.session.mePreferences.snapshot().data?.assignments[channel]).toBe(
      "g",
    );
  } finally {
    f.dispose();
  }
});

it("confirms native-shaped reordered assignment maps without losing group order", async () => {
  const f = fixture();
  try {
    f.install({ ...groups, id: "me", channels: [other] });
    f.prepare.mockImplementation(async (record) =>
      JSON.stringify(record, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
            )
          : value,
      ),
    );
    await f.session.mePreferences.ensure();
    await f.session.mePreferences.assign(channel, "work");
    expect(f.session.mePreferences.snapshot().data?.assignments).toEqual({
      [channel]: "work",
      [other]: "work",
    });
    expect(f.publish).toHaveBeenCalledOnce();
  } finally {
    f.dispose();
  }
});

it("saves initial Me placement and frozen section together within one clock second", async () => {
  const f = fixture();
  try {
    vi.mocked(Date.now).mockReturnValue(1_800_000_000_000);
    f.install({ ...groups, id: "me", channels: [] });
    await f.session.mePlacement.set(channel, true, { sectionId: "work" });
    await applySessionSetup(
      {
        ...f.session,
        canvas: {
          ...f.session.canvas,
          read: async () => undefined,
        },
      },
      channel,
      { sectionId: "work", canvas: "", agents: [] },
      () => true,
      true,
    );
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.session.mePlacement.has(channel)).toBe(true);
    expect(f.session.mePreferences.snapshot().data?.assignments[channel]).toBe(
      "work",
    );
    await f.session.mePlacement.set(channel, true, { sectionId: "work" });
    expect(f.publish).toHaveBeenCalledOnce();
  } finally {
    f.dispose();
  }
});

it("does not place a new Me channel into a deleted section", async () => {
  const f = fixture();
  try {
    await expect(
      f.session.mePlacement.set(channel, true, { sectionId: "gone" }),
    ).rejects.toThrow("The section was removed");
    expect(f.publish).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it("repairs a frozen initial section without duplicating existing Me placement", async () => {
  const f = fixture();
  try {
    f.install({ ...groups, id: "me", channels: [channel] });
    await f.session.mePlacement.set(channel, true, { sectionId: "work" });
    expect(f.session.mePlacement.has(channel)).toBe(true);
    const last = f.publish.mock.calls.at(-1)?.[0];
    if (!last) throw new Error("Missing repair");
    expect(JSON.parse(last.content).value.channels).toEqual([channel]);
    await f.session.mePreferences.refresh();
    expect(f.session.mePreferences.snapshot().data?.assignments[channel]).toBe(
      "work",
    );
  } finally {
    f.dispose();
  }
});

it.each([false, true])(
  "checks the exact Me capacity before saving (grouped=%s) and reclaims moved placement",
  async (grouped) => {
    const f = fixture();
    const value: Groups = {
      type: "groups",
      id: "me",
      groups: grouped
        ? [{ id: "work", name: "Work", defaultTemplateId: "" }]
        : [],
      assignments: {},
      channels: [],
    };
    const record = () => ({
      version: 1 as const,
      community,
      deleted: false,
      value,
    });
    let id = "";
    for (let i = 1; i < 1000; i++) {
      id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
      value.channels?.push(id);
      if (grouped) value.assignments[id] = "work";
      if (!kitRecordFits(record())) {
        value.channels?.pop();
        delete value.assignments[id];
        break;
      }
    }
    parseKitRecord(record(), community);
    f.install(value);
    const options = { sectionId: grouped ? "work" : undefined };
    try {
      await expect(f.session.mePlacement.admit(id, options)).rejects.toThrow(
        "Me storage is full",
      );
      await expect(
        f.session.mePlacement.set(id, true, options),
      ).rejects.toThrow("Me storage is full");
      expect(f.publish).not.toHaveBeenCalled();
      const removed = value.channels?.[0];
      if (!removed) throw new Error("Missing placement");
      await f.session.mePlacement.set(removed, false);
      await f.session.mePlacement.admit(id, options);
      await f.session.mePlacement.set(id, true, options);
      expect(f.session.mePlacement.has(id)).toBe(true);
      expect(f.session.mePlacement.has(removed)).toBe(false);
      await f.session.mePreferences.ensure();
      expect(
        f.session.mePreferences.snapshot().data?.assignments[removed],
      ).toBeUndefined();
    } finally {
      f.dispose();
    }
  },
);
