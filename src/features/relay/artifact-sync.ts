import type { Context } from "@deepseek-ai/cordis";
import type {
  ArtifactStorageService,
  OpenArtifactCollection,
} from "../artifact-storage/service";
import { hasEventProof } from "./events";
import type { RelaySession } from "./session";
import { reconcileArtifactSnapshot } from "./artifact-reconcile";
import { ArtifactSnapshotError } from "./artifact-snapshot";
import { captureArtifactDelivery } from "./artifact-delivery";
import { transportPartition } from "./partition";
import { RECOVERY_DELAYS_MS } from "./recovery";

const REPAIR_MS = 60_000;
type Group = {
  key: string;
  scope: string;
  entries: Set<OpenArtifactCollection>;
  lifetime: AbortController;
  request(): void;
};

/** The existing session supplies live traffic. Web Locks transfer sync work between windows. */
export function provideArtifactSync(
  ctx: Context,
  storage: ArtifactStorageService,
) {
  const groups = new Map<string, Group>();
  function ensureGroup(
    viewer: string,
    relay: string,
    owner: string,
    name: string,
  ) {
    const scope = transportPartition({ viewer, scope: relay, relayAuthor: "" });
    const key = JSON.stringify([viewer, relay, owner, name]);
    let group = groups.get(key);
    if (!group) {
      const lifetime = new AbortController();
      group = { key, scope, entries: new Set(), lifetime, request: () => {} };
      groups.set(key, group);
      const owned = group;
      if (typeof navigator !== "undefined" && navigator.locks) {
        void navigator.locks
          .request(
            `buzz-artifact-sync:${key}`,
            { mode: "exclusive", signal: lifetime.signal },
            () => own(owned, viewer, relay),
          )
          .catch((error) => {
            if (!lifetime.signal.aborted)
              console.error("Artifact sync ownership fails", error);
          });
      }
    }
    return group;
  }
  const stopOpen = storage.onOpen((entry) => {
    const group = ensureGroup(
      entry.viewer,
      entry.relay,
      entry.owner,
      entry.definition.name,
    );
    group.entries.add(entry);
    group.request();
    entry.signal.addEventListener(
      "abort",
      () => {
        group.entries.delete(entry);
        if (!group.entries.size) {
          group.lifetime.abort();
          if (groups.get(group.key) === group) groups.delete(group.key);
        }
      },
      { once: true },
    );
  });
  const refreshScope = () => {
    const { viewer, origin } = ctx.relay.snapshot();
    const scope =
      viewer && origin
        ? transportPartition({ viewer, scope: origin, relayAuthor: "" })
        : undefined;
    for (const [key, group] of groups)
      if (group.scope !== scope) {
        group.lifetime.abort();
        groups.delete(key);
      }
  };
  const stopScope = ctx.relay.subscribe(refreshScope);
  refreshScope();
  async function own(group: Group, viewer: string, relay: string) {
    let session: RelaySession | undefined;
    let stopSession = () => {};
    let stopLive = () => {};
    let stopConfirmed = () => {};
    let stopRoster = () => {};
    let connected = false;
    let running = false;
    let settled = Promise.resolve();
    let requested = true;
    let retry = 0;
    let notBefore = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let batch: AbortController | undefined;
    const active = () => {
      const now = ctx.relay.snapshot();
      return (
        now.viewer === viewer &&
        now.origin === relay &&
        now.status === "ready" &&
        !now.cached &&
        now.session.live.snapshot().status === "connected"
      );
    };
    const schedule = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        requested = true;
        void pump();
      }, delay);
    };
    const request = () => {
      requested = true;
      if (!running) {
        if (Date.now() < notBefore) {
          schedule(notBefore - Date.now());
          return;
        }
        clearTimeout(timer);
        timer = undefined;
        void pump();
      }
    };
    group.request = request;
    async function pump() {
      if (running || group.lifetime.signal.aborted || !requested || !active())
        return;
      const current = session;
      const reader = current?.artifactSnapshots;
      if (!current || !reader) return;
      running = true;
      let finish!: () => void;
      settled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      requested = false;
      batch = new AbortController();
      const signal = AbortSignal.any([group.lifetime.signal, batch.signal]);
      try {
        for (const entry of [...group.entries].slice(0, 1)) {
          if (entry.signal.aborted) continue;
          const operation = AbortSignal.any([signal, entry.signal]);
          const completeDelivery = await captureArtifactDelivery(
            current,
            entry.definition.type,
            JSON.stringify([entry.owner, entry.definition.name]),
          );
          operation.throwIfAborted();
          await reconcileArtifactSnapshot(
            reader,
            entry.collection,
            entry.definition.type,
            operation,
            {
              reportFailure: retry >= 3,
              onComplete: () => completeDelivery(operation),
            },
          );
        }
        retry = 0;
        notBefore = 0;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Artifact collection version changed"
        ) {
          group.lifetime.abort();
          if (groups.get(group.key) === group) groups.delete(group.key);
        }
        if (!signal.aborted) {
          retry++;
          const permanent =
            error instanceof ArtifactSnapshotError &&
            [
              "snapshot_limit",
              "snapshot_unsupported_scope",
              "snapshot_invalid",
            ].includes(error.code);
          if (retry <= 3 && !permanent) {
            requested = true;
            schedule(RECOVERY_DELAYS_MS[retry - 1] ?? REPAIR_MS);
          } else {
            notBefore = Date.now() + REPAIR_MS;
          }
        }
      } finally {
        finish();
        running = false;
        batch = undefined;
        if (!group.lifetime.signal.aborted) {
          if (requested && retry === 0) void pump();
          else if (!timer) schedule(REPAIR_MS);
        }
      }
    }
    const update = () => {
      const now = ctx.relay.snapshot();
      const next =
        now.viewer === viewer && now.origin === relay ? now.session : undefined;
      const changed = next !== session;
      if (next !== session) {
        batch?.abort();
        stopSession();
        stopLive();
        stopConfirmed();
        stopRoster();
        session = next;
        if (next) {
          stopSession = next.live.subscribe(update);
          const rosterKey = () =>
            JSON.stringify(
              next.channels
                .list()
                .channels.map(
                  ({
                    id,
                    cached,
                    pending,
                    readOnly,
                    ttlSeconds,
                    private: restricted,
                    members,
                  }) => [
                    id,
                    cached,
                    pending,
                    readOnly,
                    ttlSeconds,
                    restricted,
                    members,
                  ],
                )
                .sort((left, right) =>
                  String(left[0]).localeCompare(String(right[0])),
                ),
            );
          let roster = rosterKey();
          stopRoster = next.channels.subscribeList(() => {
            const updated = rosterKey();
            if (updated !== roster) {
              roster = updated;
              request();
            }
          });
          const receive = (
            events: readonly import("./events").RelayEvent[],
          ) => {
            if (
              events.some(
                (event) =>
                  hasEventProof(event) &&
                  ([45011, 9005, 44100, 44101].includes(event.kind) ||
                    (event.kind === 45010 &&
                      [...group.entries].some((entry) =>
                        event.tags.some(
                          ([name, value]) =>
                            name === "type" && value === entry.definition.type,
                        ),
                      ))),
              )
            )
              request();
          };
          stopConfirmed = next.subscribeArtifactUpdates(receive);
          stopLive = next.subscribeLive(({ events }) => receive(events), {
            replay: true,
          });
        }
      }
      const ready = active();
      if (!ready) {
        batch?.abort();
        requested = true;
      } else if (!connected || changed) {
        retry = 0;
        request();
      }
      connected = ready;
    };
    const stopRelay = ctx.relay.subscribe(update);
    update();
    try {
      await new Promise<void>((resolve) => {
        if (group.lifetime.signal.aborted) resolve();
        else
          group.lifetime.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
    } finally {
      batch?.abort();
      clearTimeout(timer);
      stopRelay();
      stopSession();
      stopLive();
      stopConfirmed();
      stopRoster();
      group.request = () => {};
      await settled;
    }
  }
  ctx.effect(() => () => {
    stopOpen();
    stopScope();
    for (const group of groups.values()) group.lifetime.abort();
    groups.clear();
  });
}
