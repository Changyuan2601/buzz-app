import type { EventData, RelayEvent } from "../relay/events.ts";
import type { LocalEvents, Outbox, OutgoingEvent } from "../relay/outbox.ts";
import { ReadError } from "../relay/errors.ts";
import type { RelayReader } from "../relay/reader.ts";
import { MAX_EVENT_BYTES } from "./catalog-envelope.ts";
import {
  AGENT_CATALOG_KIND,
  type AgentPublication,
  catalogD,
  catalogHeads,
  catalogTemplate,
  isShared,
  parsePublication,
  TEAM_CATALOG_KIND,
  type TeamPublication,
} from "./catalog-protocol.ts";

export type CatalogKind = typeof AGENT_CATALOG_KIND | typeof TEAM_CATALOG_KIND;
const KINDS: readonly CatalogKind[] = [AGENT_CATALOG_KIND, TEAM_CATALOG_KIND];
// Small pages avoid normal reader size refusals. Relay-admitted events can
// exceed this app's signer bound, so a size refusal still halves the page.
const PAGE = Math.floor((8 * 1024 * 1024 - 2) / (MAX_EVENT_BYTES + 1));
const MAX_EVENTS = 5_000;
const UNCONFIRMED =
  "The relay accepted the update, but the catalog could not confirm it.";
const READ_FAILED =
  "Could not read the community catalog. Check the community connection, then retry.";

/** queued = the relay has not answered yet; rejected = it refused or failed. */
export type CatalogDelivery = "queued" | "accepted" | "rejected";
export type CatalogShareState = Readonly<{
  /** Whether the newest relay-accepted head of this coordinate is shared. */
  shared: boolean;
  /** The newest local change of this coordinate, until it is dismissed. */
  change?: Readonly<{
    operation: string;
    shared: boolean;
    delivery: CatalogDelivery;
    /** Queued with no attempt or confirmation in flight; `retry` resumes it. */
    stalled?: true;
    error?: string;
  }>;
}>;
export type CommunityCatalogSnapshot = Readonly<{
  status: "unavailable" | "idle" | "loading" | "ready" | "error";
  error?: string;
  agents: readonly AgentPublication[];
  teams: readonly TeamPublication[];
}>;

function delivery(item: OutgoingEvent): CatalogDelivery {
  return item.delivery === "accepted" || item.delivery === "seen"
    ? "accepted"
    : item.delivery === "failed"
      ? "rejected"
      : "queued";
}
/** NIP-33 head order: newer created_at, then the lower id. */
const outranks = (a: EventData, b: EventData) =>
  a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);
const coordinate = (event: EventData) =>
  `${event.kind}:${event.pubkey}:${catalogD(event as RelayEvent) ?? ""}`;
const isCatalog = (event: EventData) =>
  (KINDS as readonly number[]).includes(event.kind) &&
  catalogD(event as RelayEvent) !== undefined;

/** The community catalog: every shared NIP-AP head readable on this relay,
 * plus this viewer's own share changes through the durable outbox. Reading
 * never executes or adopts anything; adoption is the caller's explicit act. */
export function createCommunityCatalog({
  reader,
  viewer,
  outbox,
  local,
  notify = (listener: () => void) => listener(),
}: {
  reader: RelayReader | undefined;
  viewer: string;
  outbox: Outbox | undefined;
  local: LocalEvents | undefined;
  notify?: (listener: () => void) => void;
}) {
  let closed = false;
  let relayEvents: readonly RelayEvent[] = [];
  let status: CommunityCatalogSnapshot["status"] = reader
    ? "idle"
    : "unavailable";
  let error: string | undefined;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  const demands = new Set<object>();
  const listeners = new Set<() => void>();
  let ownHeads = new Map<string, EventData>();
  // Relay-confirmed own heads (acknowledged here or read back from any of
  // this owner's devices), kept apart from the dismissible journal and the
  // transient relay read so neither a dismissal nor a disconnect can revive
  // the head a newer one replaced.
  const confirmedHeads = new Map<string, RelayEvent>();
  function retain(event: RelayEvent) {
    const key = coordinate(event);
    const known = confirmedHeads.get(key);
    if (!known || outranks(event, known)) confirmedHeads.set(key, event);
  }
  let changes = new Map<string, OutgoingEvent>();
  // An accepted receipt is not proof of the NIP-33 head: a relay holding a
  // newer head answers `duplicate:` and keeps it. Only own changes a strong
  // coordinate read returned as the head count as accepted.
  const verified = new Set<string>();
  // A confirmation read failed or found another head that does not outrank
  // the change. Re-read only on refresh or an explicit retry, never a resend.
  const unconfirmed = new Set<string>();
  const verifying = new Map<string, Promise<void>>();
  const outcome = (item: OutgoingEvent): CatalogDelivery => {
    const value = delivery(item);
    return value === "accepted" && !verified.has(item.event.id)
      ? "queued"
      : value;
  };

  function localCatalog() {
    return (local?.snapshot() ?? []).filter(
      (item) => item.event.pubkey === viewer && isCatalog(item.event),
    );
  }
  function build(): CommunityCatalogSnapshot {
    const items = localCatalog();
    // Verified local heads count immediately; the relay read catches up.
    for (const item of items)
      if (verified.has(item.event.id))
        retain((item.signed ?? item.event) as RelayEvent);
    const heads = catalogHeads([...relayEvents, ...confirmedHeads.values()]);
    ownHeads = new Map(
      [...heads].filter(([, event]) => event.pubkey === viewer),
    );
    changes = new Map();
    for (const item of items) {
      const key = coordinate(item.event);
      const current = changes.get(key);
      if (!current || outranks(item.event, current.event))
        changes.set(key, item);
    }
    // A change the observed head outranks is history, not a current notice:
    // its delivery says nothing about what readers now find.
    for (const [key, item] of changes) {
      const head = heads.get(key);
      if (head && head.id !== item.event.id && outranks(head, item.event))
        changes.delete(key);
    }
    const agents: AgentPublication[] = [];
    const teams: TeamPublication[] = [];
    for (const event of heads.values()) {
      const publication = parsePublication(event);
      if (publication?.kind === AGENT_CATALOG_KIND) agents.push(publication);
      else if (publication?.kind === TEAM_CATALOG_KIND) teams.push(publication);
    }
    const order = <T extends { createdAt: number; eventId: string }>(
      a: T,
      b: T,
    ) => b.createdAt - a.createdAt || (a.eventId < b.eventId ? -1 : 1);
    return Object.freeze({
      status,
      ...(error ? { error } : {}),
      agents: Object.freeze(agents.sort(order)),
      teams: Object.freeze(teams.sort(order)),
    });
  }
  let snapshot = build();
  function publish() {
    snapshot = build();
    for (const listener of listeners) notify(listener);
  }
  const stopLocal = local?.subscribe(() => {
    if (closed) return;
    publish();
    void verifyAccepted();
  });

  /** The authoritative head of one own or listed coordinate. */
  async function readHead(kind: CatalogKind, owner: string, d: string) {
    if (!reader) throw new Error("The community catalog is unavailable.");
    const events = await reader.read(
      [
        {
          kinds: [kind],
          authors: [owner],
          "#d": [d],
          limit: 20,
          consistency: "strong",
        },
      ],
      // Never join a read that predates this intent or write.
      { priority: "foreground", fresh: true },
    );
    return catalogHeads(
      events.filter((event) => event.pubkey === owner && catalogD(event) === d),
    ).get(`${kind}:${owner}:${d}`);
  }
  async function verify(item: OutgoingEvent) {
    const d = catalogD(item.event as RelayEvent);
    if (d === undefined) return;
    let head: RelayEvent | undefined;
    try {
      head = await readHead(item.event.kind as CatalogKind, viewer, d);
    } catch {
      head = undefined;
    }
    if (closed) return;
    if (head) retain(head);
    if (head?.id === item.event.id) {
      verified.add(item.event.id);
      unconfirmed.delete(item.event.id);
    } else unconfirmed.add(item.event.id);
    publish();
  }
  /** Promotes accepted own changes only once the relay's head is theirs. */
  function verifyAccepted(): Promise<void> {
    if (closed || !reader) return Promise.resolve();
    const checks: Promise<void>[] = [];
    for (const item of localCatalog()) {
      const id = item.event.id;
      if (
        delivery(item) !== "accepted" ||
        verified.has(id) ||
        unconfirmed.has(id)
      )
        continue;
      let check = verifying.get(id);
      if (!check) {
        check = verify(item).finally(() => verifying.delete(id));
        verifying.set(id, check);
      }
      checks.push(check);
    }
    return Promise.all(checks).then(() => {});
  }

  async function readAll(reader: RelayReader, signal: AbortSignal) {
    const events: RelayEvent[] = [];
    let cursor: { until: number; before_id: string } | undefined;
    let limit = PAGE;
    for (;;) {
      signal.throwIfAborted();
      let page: readonly RelayEvent[];
      try {
        page = await reader.read([{ kinds: [...KINDS], limit, ...cursor }], {
          signal,
          priority: "background",
        });
      } catch (problem) {
        if (
          problem instanceof ReadError &&
          problem.kind === "invalid-response" &&
          problem.message === "Relay response exceeds the read budget" &&
          limit > 1
        ) {
          limit = Math.floor(limit / 2);
          continue; // Retry the same cursor; no page was accepted.
        }
        throw problem;
      }
      signal.throwIfAborted();
      // Unshared foreign heads are withheld by the relay; the head rule still
      // applies so a stale shared copy can never outrank a newer own unshare.
      events.push(...page.filter((event) => isCatalog(event)));
      if (events.length > MAX_EVENTS)
        throw new Error("Community catalog exceeds read budget");
      const last = page.at(-1);
      if (page.length < limit || !last) return events;
      cursor = { until: last.created_at, before_id: last.id };
    }
  }

  function refresh(): Promise<void> {
    if (closed || !reader) return Promise.resolve();
    if (pending) return pending;
    const owned = new AbortController();
    controller = owned;
    status = "loading";
    publish();
    pending = readAll(reader, owned.signal)
      .then((events) => {
        if (closed || owned.signal.aborted) return;
        relayEvents = Object.freeze(events);
        for (const event of events) if (event.pubkey === viewer) retain(event);
        status = "ready";
        error = undefined;
        unconfirmed.clear();
        publish();
        return verifyAccepted();
      })
      .catch(() => {
        if (closed || owned.signal.aborted) return;
        status = "error";
        error = READ_FAILED;
        publish();
      })
      .finally(() => {
        if (controller === owned) {
          controller = undefined;
          pending = undefined;
        }
      });
    return pending;
  }

  function state(kind: CatalogKind, d: string): CatalogShareState {
    const key = `${kind}:${viewer}:${d}`;
    const head = ownHeads.get(key);
    const item = changes.get(key);
    return Object.freeze({
      shared: !!head && isShared(head as RelayEvent),
      ...(item
        ? {
            change: Object.freeze({
              operation: item.event.id,
              shared: isShared(item.event as RelayEvent),
              delivery: outcome(item),
              ...(item.delivery === "unknown" || unconfirmed.has(item.event.id)
                ? { stalled: true as const }
                : {}),
              ...(item.error
                ? { error: item.error }
                : unconfirmed.has(item.event.id)
                  ? { error: UNCONFIRMED }
                  : {}),
            }),
          }
        : {}),
    });
  }

  /** Re-reads a listed team's coordinate so adoption uses exactly the head
   * that was previewed, and only while it is still shared. */
  async function currentTeam(
    listed: TeamPublication,
  ): Promise<TeamPublication> {
    if (closed || !reader)
      throw new Error("This team is no longer available in the catalog.");
    let head: RelayEvent | undefined;
    try {
      head = await readHead(TEAM_CATALOG_KIND, listed.owner, listed.d);
    } catch {
      throw new Error(READ_FAILED);
    }
    if (!head)
      throw new Error("This team is no longer available in the catalog.");
    if (head.id !== listed.eventId)
      throw new Error(
        "This team has changed since it was listed. Refresh and try again.",
      );
    if (!isShared(head))
      throw new Error("This team is no longer shared to the community.");
    const publication = parsePublication(head);
    if (publication?.kind !== TEAM_CATALOG_KIND)
      throw new Error("This team is no longer available in the catalog.");
    return publication;
  }

  return {
    queries: Object.freeze({
      snapshot: () => snapshot,
      currentTeam,
      available: () => !!reader,
      writable: () => !!outbox?.supports(AGENT_CATALOG_KIND),
      refresh,
      retain() {
        const demand = {};
        demands.add(demand);
        void refresh();
        return () => {
          demands.delete(demand);
        };
      },
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      state,
      /** Publish a share or unshare head for one of the viewer's coordinates.
       * Unsharing is a newer head without the `shared` tag (NIP-AP), never a
       * deletion; adopted copies are separate, locally owned records. When
       * `content` is omitted the newest known content is reused. Nothing is
       * sent once `active` reports the requester gone. */
      async publish(
        kind: CatalogKind,
        d: string,
        shared: boolean,
        content?: string,
        active: () => boolean = () => true,
      ): Promise<string> {
        const writable = () => !closed && !!outbox?.supports(kind);
        if (!writable())
          throw new Error("This community cannot update catalog sharing.");
        if (status !== "ready")
          throw new Error("The community catalog is still loading. Try again.");
        // The replacement must outrank the relay's current head, including one
        // another device published after the catalog read.
        let current: RelayEvent | undefined;
        try {
          current = await readHead(kind, viewer, d);
        } catch {
          throw new Error(READ_FAILED);
        }
        if (!writable() || !outbox)
          throw new Error("This community cannot update catalog sharing.");
        if (!active())
          throw new DOMException("Catalog sharing cancelled", "AbortError");
        if (current) {
          retain(current);
          publish();
        }
        const key = `${kind}:${viewer}:${d}`;
        const body =
          content ??
          changes.get(key)?.event.content ??
          ownHeads.get(key)?.content;
        if (body === undefined)
          throw new Error("Nothing has been shared from this coordinate.");
        const previous = changes.get(key);
        const head = ownHeads.get(key);
        const id = outbox.send({
          ...catalogTemplate(kind, d, body, shared),
          ...(head ? { supersedes: head.created_at } : {}),
        });
        // The new head is newer, so a refused older change is only clutter.
        if (previous && delivery(previous) === "rejected")
          void outbox.dismiss(previous.event.id).catch(() => {});
        return id;
      },
      retry(operation: string) {
        const item = localCatalog().find(
          (entry) => entry.event.id === operation,
        );
        // The relay already took an accepted or seen change: re-read its
        // head, never resend it, even if a refresh cleared the marker.
        if (item && delivery(item) === "accepted") {
          if (unconfirmed.delete(operation)) publish();
          void verifyAccepted();
        } else outbox?.retry(operation);
      },
      dismiss(operation: string) {
        return outbox?.dismiss(operation) ?? Promise.resolve();
      },
    }),
    clear() {
      controller?.abort();
      controller = undefined;
      pending = undefined;
      relayEvents = [];
      // A disconnect doesn't undo what the relay confirmed; keeping these
      // stops the journal from reviving a share a dismissed unshare replaced.
      status = closed || !reader ? "unavailable" : "idle";
      error = undefined;
      publish();
    },
    reconnect() {
      if (demands.size && status !== "ready") void refresh();
    },
    dispose() {
      closed = true;
      stopLocal?.();
      demands.clear();
      controller?.abort();
      relayEvents = [];
      confirmedHeads.clear();
      verified.clear();
      unconfirmed.clear();
      status = "unavailable";
      publish();
      listeners.clear();
    },
  };
}
