import type { RelayReader } from "../relay/reader";
import type { RelayEvent } from "../relay/events";
import {
  ASSISTIVE_EXPERIENCES,
  type AssistiveExperienceId,
  type AssistiveFacts,
} from "./catalog";
import {
  assistiveCoordinate,
  factKey,
  parseFact,
  OUTCOMES,
  MAX_MARKERS,
  type AssistiveHost,
  type ProgressFact,
  type ProgressAddress,
  type AssistiveOutcome,
} from "./protocol";

export type ProgressSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error" | "unavailable";
  facts: readonly ProgressFact[];
  pending: number;
  error?: string | undefined;
}>;
export type AssistiveProgress = ReturnType<
  typeof createAssistiveProgress
>["capability"];
type Stored = {
  version: 1;
  fact: ProgressFact;
  pending: boolean;
  event?: RelayEvent;
};
const PREFIX = "buzz-assistive-progress.v1:";

/** Independent add-only facts. The community session owns transport and lifetime. */
export function createAssistiveProgress({
  host,
  reader,
  viewer,
  community,
  signal,
}: {
  host: AssistiveHost | undefined;
  reader: RelayReader;
  viewer: string;
  community: string;
  signal: AbortSignal;
}) {
  const page = typeof window === "undefined" ? undefined : window;
  const prefix = `${PREFIX}${JSON.stringify([community, viewer])}:`;
  const entries = new Map<string, Stored>();
  const unsaved = new Set<string>();
  const listeners = new Set<() => void>();
  let state: ProgressSnapshot = {
    status: host ? "idle" : "unavailable",
    facts: [],
    pending: 0,
  };
  let pending: Promise<void> | undefined;
  let refreshAgain = false;
  let requested = false;
  let closed = false;
  let epoch = 0;
  let cycle = new AbortController();
  let addresses: readonly ProgressAddress[] | undefined;
  const active = () => !closed && !signal.aborted;
  const notify = (status = state.status, error?: string) => {
    state = Object.freeze({
      status,
      facts: Object.freeze(
        [...entries.values()].map((row) => Object.freeze(row.fact)),
      ),
      pending: [...entries.values()].filter((row) => row.pending).length,
      error,
    });
    for (const listener of listeners) listener();
  };
  function restore() {
    for (const id of Object.keys(
      ASSISTIVE_EXPERIENCES,
    ) as AssistiveExperienceId[])
      for (const outcome of OUTCOMES) {
        const fact = { id, outcome };
        const key = factKey(fact);
        const raw = localStorage.getItem(`${prefix}${key}`);
        if (!raw) continue;
        const row: Stored = JSON.parse(raw);
        if (
          row?.version !== 1 ||
          typeof row.pending !== "boolean" ||
          factKey(parseFact(row.fact)) !== key
        )
          throw new Error("Saved assistive progress is invalid");
        // A peer's accepted copy covers this same immutable fact. Unsaved memory stays local.
        if (!unsaved.has(key)) entries.set(key, row);
      }
  }
  function save(row: Stored) {
    const key = factKey(row.fact);
    const value = JSON.stringify(row);
    localStorage.setItem(`${prefix}${key}`, value);
    if (localStorage.getItem(`${prefix}${key}`) !== value)
      throw new Error("Assistive progress could not be saved on this device");
    entries.set(key, row);
    unsaved.delete(key);
  }
  async function verify(
    events: readonly RelayEvent[],
    workSignal: AbortSignal,
  ) {
    if (!host) throw new Error("Assistive codec unavailable");
    const decoded = await host.decode(events, workSignal);
    workSignal.throwIfAborted();
    if (decoded.length !== events.length)
      throw new Error("Incomplete assistive decode");
    return decoded.map((row) => {
      const fact = parseFact(row.fact);
      const event = events.find((e) => e.id === row.eventId);
      const address = addresses?.find((a) => factKey(a) === factKey(fact));
      if (
        !event ||
        event.pubkey !== viewer ||
        !address ||
        assistiveCoordinate(event) !== address.coordinate
      )
        throw new Error("Assistive response mismatch");
      return fact;
    });
  }
  async function synchronize(workSignal: AbortSignal) {
    if (!host) return;
    restore();
    for (const key of [...unsaved]) {
      const row = entries.get(key);
      if (row) save(row);
    }
    const nextAddresses = addresses ?? (await host.addresses(workSignal));
    workSignal.throwIfAborted();
    const expected = Object.keys(ASSISTIVE_EXPERIENCES).flatMap((id) =>
      OUTCOMES.map((outcome) => `${id}:${outcome}`),
    );
    if (
      !nextAddresses.length ||
      nextAddresses.length > MAX_MARKERS ||
      nextAddresses.length !== expected.length ||
      new Set(nextAddresses.map((a) => a.coordinate)).size !==
        expected.length ||
      new Set(nextAddresses.map(factKey)).size !== expected.length ||
      nextAddresses.some(
        (a) =>
          !expected.includes(factKey(a)) ||
          !/^buzz-assistive-v1:[a-f0-9]{64}$/.test(a.coordinate),
      )
    )
      throw new Error("Incomplete assistive address set");
    addresses = nextAddresses;
    // A separate exact-coordinate read avoids combined result caps hiding other facts.
    for (const address of addresses) {
      const events = await reader.read(
        [
          {
            kinds: [30078],
            authors: [viewer],
            "#d": [address.coordinate],
            limit: 1,
            consistency: "strong",
          },
        ],
        { signal: workSignal, fresh: true },
      );
      workSignal.throwIfAborted();
      if (events.length > 1) throw new Error("Ambiguous assistive coordinate");
      const facts = await verify(events, workSignal);
      if (facts.some((fact) => factKey(fact) !== factKey(address)))
        throw new Error("Assistive query mismatch");
      for (const fact of facts) {
        entries.set(factKey(fact), { version: 1, fact, pending: false });
        save({ version: 1, fact, pending: false });
      }
    }
    for (const row of [...entries.values()]) {
      workSignal.throwIfAborted();
      if (!row.pending) continue;
      let event = row.event;
      if (!event || Math.abs(event.created_at - Date.now() / 1000) > 60) {
        event = await host.sign(row.fact, workSignal);
        workSignal.throwIfAborted();
      }
      const [signedFact] = await verify([event], workSignal);
      if (!signedFact || factKey(signedFact) !== factKey(row.fact))
        throw new Error("Assistive signing mismatch");
      save({ ...row, event }); // Save exact bytes before entering publication.
      workSignal.throwIfAborted();
      await host.publish(event, workSignal);
      workSignal.throwIfAborted();
      // Another device's equivalent head is also confirmation, even when our ID lost a tie.
      const coordinate = assistiveCoordinate(event);
      const echoed = await reader.read(
        [
          {
            kinds: [30078],
            authors: [viewer],
            "#d": [coordinate ?? ""],
            limit: 1,
            consistency: "strong",
          },
        ],
        { signal: workSignal, fresh: true },
      );
      workSignal.throwIfAborted();
      const confirmed = await verify(echoed, workSignal);
      if (
        confirmed.length !== 1 ||
        !confirmed[0] ||
        factKey(confirmed[0]) !== factKey(row.fact)
      )
        throw new Error("Assistive publication could not be confirmed");
      save({ version: 1, fact: row.fact, pending: false });
    }
  }
  function refresh(): Promise<void> {
    if (!active() || !host) return Promise.resolve();
    requested = true;
    if (pending) return pending;
    const generation = epoch;
    const workSignal = AbortSignal.any([signal, cycle.signal]);
    // Schedule after assigning the owner: synchronous storage failures must not wedge retry.
    pending = Promise.resolve()
      .then(() => synchronize(workSignal))
      .then(() => {
        if (active() && generation === epoch) notify("ready");
      })
      .catch((error: unknown) => {
        if (active() && generation === epoch)
          notify(
            "error",
            error instanceof Error
              ? error.message
              : "Assistive synchronization failed",
          );
      })
      .finally(() => {
        pending = undefined;
        if (refreshAgain && active()) {
          refreshAgain = false;
          void refresh();
        }
      });
    notify("loading");
    return pending;
  }
  const requestRefresh = () => {
    if (pending) refreshAgain = true;
    else void refresh();
  };
  const changed = (event: StorageEvent) => {
    if (!active()) return;
    try {
      if (
        event.storageArea !== localStorage ||
        (event.key !== null && !event.key.startsWith(prefix))
      )
        return;
      restore();
      notify();
      if (requested) requestRefresh();
    } catch {
      notify("error", "Saved assistive progress could not be restored");
    }
  };
  page?.addEventListener("storage", changed);
  const capability = Object.freeze({
    snapshot: () => state,
    subscribe(listener: () => void) {
      if (!active()) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure() {
      if (!requested) void refresh();
    },
    refresh,
    eligibility<Id extends AssistiveExperienceId>(
      id: Id,
      facts: AssistiveFacts[Id],
    ): "eligible" | "ineligible" | "unknown" {
      const definition = Object.hasOwn(ASSISTIVE_EXPERIENCES, id)
        ? ASSISTIVE_EXPERIENCES[id]
        : undefined;
      if (!active() || !definition?.eligible(facts)) return "ineligible";
      if (
        definition.retired(
          new Set(
            state.facts
              .filter((fact) => fact.id === id)
              .map((fact) => fact.outcome),
          ),
        )
      )
        return "ineligible";
      return state.status === "ready" ? "eligible" : "unknown";
    },
    async record(
      id: AssistiveExperienceId,
      outcome: AssistiveOutcome,
    ): Promise<"saved" | "unsaved" | "unavailable"> {
      if (!active() || !host || !/^[a-f0-9]{64}$/.test(viewer))
        return "unavailable";
      const fact = parseFact({ id, outcome });
      const key = factKey(fact);
      try {
        restore();
      } catch {
        entries.set(key, { version: 1, fact, pending: true });
        unsaved.add(key);
        notify("error", "Saved assistive progress could not be restored");
        return "unsaved";
      }
      const row = entries.get(key) ?? {
        version: 1 as const,
        fact,
        pending: true,
      };
      try {
        save(row);
      } catch {
        entries.set(key, row);
        unsaved.add(key);
        notify("error", "Assistive progress could not be saved on this device");
        return "unsaved";
      }
      notify();
      requestRefresh();
      return "saved"; // Local durability only; snapshot reports relay settlement.
    },
  });
  return {
    capability,
    receive(events: readonly RelayEvent[]) {
      if (
        requested &&
        events.some(
          (event) => event.pubkey === viewer && assistiveCoordinate(event),
        )
      )
        requestRefresh();
    },
    connected() {
      if (requested) requestRefresh();
    },
    disconnected() {
      epoch++;
      cycle.abort();
      cycle = new AbortController();
      refreshAgain = false;
      if (requested) notify("error", "Assistive synchronization is offline");
    },
    clear() {
      epoch++;
      cycle.abort();
      cycle = new AbortController();
      addresses = undefined;
      refreshAgain = requested && !!pending;
      notify(host ? "idle" : "unavailable");
      if (requested && !pending) requestRefresh();
    },
    dispose() {
      closed = true;
      epoch++;
      cycle.abort();
      listeners.clear();
      page?.removeEventListener("storage", changed);
    },
  };
}
