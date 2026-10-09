import type { RelayReader } from "../relay/reader";
import type { RelayEvent, ReadFilter } from "../relay/events";
import type { Outbox, LocalEvents } from "../relay/outbox";
import type { ChannelKitHost } from "./host";
import { isDefinitiveCanvasConflict } from "./canvas-conflict";
import {
  CANVAS_BYTES,
  coordinate,
  KIT_TAG,
  ME_KIT_TAG,
  kitTag,
  parseKitRecord,
  type KitEntry,
  type KitRecord,
  type KitValue,
  type Team,
  type PayloadRecord,
  parsePayloadRecord,
  privateCoordinate,
} from "./model";
import {
  TEAM_MANIFEST_TAG,
  TEAM_PAYLOAD_TAG,
  encodeTeamPayload,
  decodeTeamPayload,
  payloadCoordinate,
  parseTeamManifest,
} from "./team-payload";
import type { TeamSnapshot } from "../agents/team-bundles";

const canvasConflict =
  "Canvas changed since you opened it. Your draft is kept; load the current document before replacing it.";

export type CanvasHistoryCursor = { until: number; before_id: string };
export type CanvasHistoryPage = {
  revisions: readonly RelayEvent[];
  next: CanvasHistoryCursor | undefined;
};

export const selectedHead = (events: readonly RelayEvent[]) =>
  [...events].sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  )[0];
type Snapshot = {
  status: "idle" | "loading" | "ready" | "error" | "unavailable";
  entries: readonly KitEntry[];
  error?: string | undefined;
};
/** Session-owned reads and narrow recipe operations; the existing outbox owns delivery. */
export function createChannelKit({
  host,
  reader,
  outbox,
  local,
  ready,
  viewer,
  community,
  signal,
  canWrite,
  delivered,
}: {
  host: ChannelKitHost | undefined;
  reader: RelayReader;
  outbox: Outbox | undefined;
  local: LocalEvents | undefined;
  ready: Promise<void> | undefined;
  viewer: string;
  community: string;
  signal: AbortSignal;
  canWrite(channel: string): boolean;
  delivered(id: string): Promise<void>;
}) {
  let state: Snapshot = { status: host ? "idle" : "unavailable", entries: [] };
  let pending: Promise<void> | undefined;
  let saving = false;
  let epoch = 0;
  const listeners = new Set<() => void>();
  const update = (next: Snapshot) => {
    signal.throwIfAborted();
    state = next;
    listeners.forEach((l) => {
      l();
    });
  };
  const fresh = (filters: readonly ReadFilter[], readSignal = signal) =>
    reader.read(filters, { signal: readSignal, fresh: true });
  async function readRecord(record: KitRecord, readSignal = signal) {
    return selectedHead(
      await fresh(
        [
          {
            kinds: [30078],
            authors: [viewer],
            "#d": [coordinate(record)],
            limit: 1,
          },
        ],
        readSignal,
      ),
    );
  }
  async function refresh() {
    if (!host) return;
    if (pending) return pending;
    const generation = epoch;
    update({ ...state, status: "loading", error: undefined });
    pending = (async () => {
      try {
        const events = await fresh([
          {
            kinds: [30078],
            authors: [viewer],
            "#t": [KIT_TAG, TEAM_MANIFEST_TAG, ME_KIT_TAG],
            limit: 500,
          },
        ]);
        if (events.length >= 500)
          throw new Error(
            "Recipe catalog reached its read limit; no partial catalog will be used",
          );
        const heads = new Map<string, RelayEvent>();
        for (const event of events) {
          const d = event.tags.find((t) => t[0] === "d")?.[1];
          if (
            !d ||
            ![KIT_TAG, TEAM_MANIFEST_TAG, ME_KIT_TAG].some((tag) =>
              d?.startsWith(`${tag}:${encodeURIComponent(community)}:`),
            )
          )
            continue;
          const old = heads.get(d);
          if (!old || selectedHead([event, old])?.id === event.id)
            heads.set(d, event);
        }
        const rows = [...heads.values()],
          entries: KitEntry[] = [];
        for (let start = 0; start < rows.length; start += 16) {
          const batch = rows.slice(start, start + 16);
          const decoded = await host.decode(batch, signal);
          if (!Array.isArray(decoded) || decoded.length !== batch.length)
            throw new Error("Incomplete private recipe decode");
          for (const row of decoded) {
            const event = batch.find((e) => e.id === row.eventId);
            const record = parseKitRecord(row.record, community);
            if (
              !event ||
              event.tags.find((t) => t[0] === "d")?.[1] !== coordinate(record)
            )
              throw new Error("Recipe decode mismatch");
            entries.push({
              record,
              eventId: event.id,
              createdAt: event.created_at,
            });
          }
        }
        if (generation === epoch) update({ status: "ready", entries });
      } catch (error) {
        if (!signal.aborted && generation === epoch)
          update({ ...state, status: "error", error: String(error) });
      } finally {
        if (generation === epoch) pending = undefined;
      }
    })();
    return pending;
  }
  async function confirm(id: string) {
    try {
      if (
        (await fresh([{ ids: [id], limit: 1, consistency: "strong" }])).some(
          (e) => e.id === id,
        )
      )
        return;
      const saved = local?.snapshot().find((e) => e.event.id === id);
      if (!saved || Date.now() / 1000 - saved.event.created_at >= 15 * 60)
        throw new Error(
          "This operation could not be confirmed and is too old to replay. Keep your draft and inspect the current result before making a new save.",
        );
      // A proven Canvas CAS refusal cannot become valid by replaying these bytes.
      if (isDefinitiveCanvasConflict(saved)) throw new Error(saved.error);
      await delivered(id);
      if (
        !(await fresh([{ ids: [id], limit: 1, consistency: "strong" }])).some(
          (e) => e.id === id,
        )
      )
        throw new Error(
          "Save is awaiting exact relay confirmation; your draft is kept",
        );
    } catch (error) {
      const failed = local?.snapshot().find((item) => item.event.id === id);
      if (outbox && isDefinitiveCanvasConflict(failed)) {
        // Refused before mutation. Release the pending gate, not uncertain saves.
        await outbox.dismiss(id);
        throw new Error(canvasConflict);
      }
      throw error;
    }
  }
  const capability = Object.freeze({
    available: !!host && !!outbox?.supports(30078),
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure() {
      if (state.status === "idle") void refresh();
    },
    refresh,
    async loadTeam(team: Team): Promise<unknown> {
      if (!host || !team.portable)
        throw new Error("This team has no portable definition");
      const manifest = parseTeamManifest(team.portable);
      if (manifest.owner !== viewer)
        throw new Error("Portable team belongs to another viewer");
      const payloads: PayloadRecord["value"][] = [];
      // Exact revision reads only. Never include chunks in recipe discovery.
      for (let index = 0; index < manifest.chunks; index++) {
        signal.throwIfAborted();
        const coordinate = payloadCoordinate({
          community,
          owner: viewer,
          teamId: team.id,
          revision: manifest.revision,
          index,
        });
        const events = await fresh([
          {
            kinds: [30078],
            authors: [viewer],
            "#d": [coordinate],
            limit: 2,
            consistency: "strong",
          },
        ]);
        const event = selectedHead(events);
        if (!event) throw new Error("Portable team payload is unavailable");
        const decoded = await host.decode([event], signal);
        const row = decoded[0];
        if (!row || decoded.length !== 1 || row.eventId !== event.id)
          throw new Error("Incomplete portable team payload decode");
        const record = parsePayloadRecord(row.record, community);
        if (
          privateCoordinate(record) !== coordinate ||
          !event.tags.some(
            ([tag, value]) => tag === "d" && value === coordinate,
          )
        )
          throw new Error("Portable team payload coordinate mismatch");
        payloads.push(record.value);
      }
      return decodeTeamPayload(manifest, payloads, community, viewer, team.id);
    },
    async savePortable(
      team: Omit<Team, "portable">,
      snapshot: TeamSnapshot,
      expected: string | undefined,
      revision: string,
      operationSignal?: AbortSignal,
    ) {
      const preparing = operationSignal
        ? AbortSignal.any([signal, operationSignal])
        : signal;
      preparing.throwIfAborted();
      if (
        !host ||
        !outbox ||
        !team.agents.length ||
        team.agents.length !== snapshot.members.length ||
        team.name !== snapshot.team.name
      )
        throw new Error("Portable team members do not match their definitions");
      const { manifest, payloads } = await encodeTeamPayload(
        snapshot,
        community,
        viewer,
        team.id,
        revision,
      );
      await ready;
      for (const payload of payloads) {
        preparing.throwIfAborted();
        const record: PayloadRecord = {
          version: 1,
          community,
          deleted: false,
          value: {
            ...payload,
            type: "team-payload",
            id: `${payload.revision}-${payload.index}`,
          },
        };
        const coordinate = privateCoordinate(record);
        const existing = selectedHead(
          await fresh(
            [
              {
                kinds: [30078],
                authors: [viewer],
                "#d": [coordinate],
                limit: 1,
                consistency: "strong",
              },
            ],
            preparing,
          ),
        );
        if (existing) {
          const rows = await host.decode([existing], preparing);
          const row = rows[0];
          if (
            !row ||
            row.eventId !== existing.id ||
            JSON.stringify(parsePayloadRecord(row.record, community)) !==
              JSON.stringify(record)
          )
            throw new Error(
              "Portable team revision already has different content",
            );
          continue;
        }
        const pending = local
          ?.snapshot()
          .find(
            (item) =>
              item.event.kind === 30078 &&
              item.event.tags.some(
                ([tag, value]) => tag === "d" && value === coordinate,
              ),
          );
        const id =
          pending?.event.id ??
          outbox.send({
            kind: 30078,
            content: await host.prepare(record, preparing),
            tags: [
              ["d", coordinate],
              ["t", TEAM_PAYLOAD_TAG],
            ],
          });
        await confirm(id);
      }
      const value: Team = { ...team, portable: manifest };
      // Confirm complete payload availability/integrity before replacing the manifest.
      await capability.loadTeam(value);
      return capability.save(value, expected, false, preparing);
    },
    async save(
      value: KitValue,
      expected: string | undefined,
      deleted = false,
      operationSignal?: AbortSignal,
    ) {
      // Before enqueue, the caller can cancel preparation. After enqueue, the
      // durable outbox and session own delivery; caller cancellation cannot undo it.
      const preparing = operationSignal
        ? AbortSignal.any([signal, operationSignal])
        : signal;
      preparing.throwIfAborted();
      if (!host || !outbox || saving)
        throw new Error("Recipe saving is unavailable or already in progress");
      const record = parseKitRecord(
        {
          version: value.type === "team" && value.portable ? 2 : 1,
          community,
          value,
          deleted,
        },
        community,
      );
      saving = true;
      try {
        await ready;
        preparing.throwIfAborted();
        const head = await readRecord(record, preparing);
        preparing.throwIfAborted();
        if (head?.id !== expected)
          throw new Error(
            "This saved recipe changed. Refresh the catalog and review your draft before replacing it.",
          );
        const previous = local
          ?.snapshot()
          .find(
            (e) =>
              e.event.kind === 30078 &&
              e.event.tags.some(
                (t) => t[0] === "d" && t[1] === coordinate(record),
              ) &&
              !["accepted", "seen"].includes(e.delivery),
          );
        if (previous)
          throw new Error(
            "A save for this recipe is unresolved. Inspect Outbox and refresh before replacing it.",
          );
        // Replaceable records use seconds. Do not create an ambiguous equal-time replacement.
        if (head && head.created_at >= Math.floor(Date.now() / 1000))
          throw new Error(
            "Please wait a second before saving this recipe again",
          );
        const content = await host.prepare(record, preparing);
        preparing.throwIfAborted();
        const id = outbox.send({
          kind: 30078,
          content,
          tags: [
            ["d", coordinate(record)],
            ["t", kitTag(record)],
          ],
        });
        await confirm(id);
        if ((await readRecord(record))?.id !== id)
          throw new Error(
            "Another recipe save is selected. Your draft is kept; refresh and review before saving again.",
          );
        await refresh();
        return id;
      } finally {
        saving = false;
      }
    },
  });
  const canvas = Object.freeze({
    available: !!outbox?.supports(40100),
    async read(channel: string, { strong = true }: { strong?: boolean } = {}) {
      signal.throwIfAborted();
      if (!canWrite(channel))
        throw new Error("Canvas is unavailable after channel access changed");
      return selectedHead(
        await fresh([
          {
            kinds: [40100],
            "#h": [channel],
            limit: 1,
            ...(strong ? { consistency: "strong" as const } : {}),
          },
        ]),
      );
    },
    async history(
      channel: string,
      cursor?: CanvasHistoryCursor,
    ): Promise<CanvasHistoryPage> {
      signal.throwIfAborted();
      if (!canWrite(channel))
        throw new Error("Canvas is unavailable after channel access changed");
      const rows = await fresh([
        {
          kinds: [40100],
          "#h": [channel],
          limit: 25,
          ...(cursor ?? { consistency: "strong" as const }),
        },
      ]);
      signal.throwIfAborted();
      if (!canWrite(channel))
        throw new Error("Canvas is unavailable after channel access changed");
      if (
        rows.some(
          (event) =>
            event.kind !== 40100 ||
            !event.tags.some((tag) => tag[0] === "h" && tag[1] === channel) ||
            (cursor &&
              (event.created_at > cursor.until ||
                (event.created_at === cursor.until &&
                  event.id <= cursor.before_id))),
        )
      )
        throw new Error(
          "Canvas history returned an invalid or non-advancing page",
        );
      const revisions = [
        ...new Map(rows.map((event) => [event.id, event])).values(),
      ].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
      const last = revisions.at(-1);
      return {
        revisions,
        next:
          rows.length >= 25 && last
            ? { until: last.created_at, before_id: last.id }
            : undefined,
      };
    },
    async save(channel: string, content: string, expected: string | undefined) {
      signal.throwIfAborted();
      if (!outbox?.supports(40100) || !canWrite(channel))
        throw new Error("Canvas writing is unavailable in this channel");
      if (new TextEncoder().encode(content).length > CANVAS_BYTES)
        throw new Error("Keep Canvas below 24 KiB");
      await ready;
      signal.throwIfAborted();
      const head = await canvas.read(channel);
      if (head?.id !== expected) throw new Error(canvasConflict);
      const pending = local
        ?.snapshot()
        .find(
          (e) =>
            e.event.kind === 40100 &&
            e.event.tags.some((t) => t[0] === "h" && t[1] === channel) &&
            !["accepted", "seen"].includes(e.delivery),
        );
      if (pending)
        throw new Error(
          "This channel has an unresolved Canvas save. Inspect Outbox before making another save.",
        );
      if (head && head.created_at >= Math.floor(Date.now() / 1000))
        throw new Error("Please wait a second before saving Canvas again");
      if (!canWrite(channel)) throw new Error("Channel access changed");
      const id = outbox.send({
        kind: 40100,
        content,
        tags: [
          ["h", channel],
          ["expected-revision", expected ?? "none"],
        ],
      });
      await confirm(id);
      const selected = await canvas.read(channel);
      if (selected?.id !== id)
        throw new Error(
          "Your save was received, but a different Canvas is selected. Your draft is kept; load the current document.",
        );
      return selected;
    },
  });
  signal.addEventListener(
    "abort",
    () => {
      state = { status: "unavailable", entries: [] };
      listeners.forEach((l) => {
        l();
      });
      listeners.clear();
    },
    { once: true },
  );
  return {
    capability,
    canvas,
    confirm,
    clear() {
      epoch++;
      pending = undefined;
      state = {
        status: host && !signal.aborted ? "idle" : "unavailable",
        entries: [],
      };
      listeners.forEach((l) => {
        l();
      });
    },
  };
}
export type ChannelKit = ReturnType<typeof createChannelKit>["capability"];
export type ChannelCanvas = ReturnType<typeof createChannelKit>["canvas"];
