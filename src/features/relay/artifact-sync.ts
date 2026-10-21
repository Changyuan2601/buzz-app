import type { Context } from "@deepseek-ai/cordis";
import type {
  ArtifactStorageService,
  OpenArtifactCollection,
} from "../artifact-storage/service";
import { hasEventProof } from "./events";
import type { RelaySession } from "./session";
import {
  reconcileArtifactDelta,
  reconcileArtifactCurrent,
} from "./artifact-reconcile";
import { ArtifactSyncError, ARTIFACT_SYNC_LIMITS } from "./artifact-reader";
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
    const dirty = new Set<string>();
    let retry = 0;
    let retryKind: "delta" | "current" | undefined;
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
    const schedule = (delay: number, delta = false) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        requested ||= delta;
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
    const repair = setInterval(request, REPAIR_MS);
    async function pump() {
      if (
        running ||
        !group.entries.size ||
        group.lifetime.signal.aborted ||
        !active()
      )
        return;
      if (Date.now() < notBefore) {
        schedule(notBefore - Date.now());
        return;
      }
      const current = session;
      const reader = current?.artifactSync;
      if (!current || !reader) return;
      clearTimeout(timer);
      timer = undefined;
      running = true;
      let finish!: () => void;
      settled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      batch = new AbortController();
      const signal = AbortSignal.any([group.lifetime.signal, batch.signal]);
      let syncing: OpenArtifactCollection | undefined;
      let deltaWork = false;
      try {
        const entry = [...group.entries][0];
        if (!entry || entry.signal.aborted) return;
        syncing = entry;
        const operation = AbortSignal.any([signal, entry.signal]);
        const accepted = await captureArtifactDelivery(
          current,
          entry.definition.type,
          JSON.stringify([entry.owner, entry.definition.name]),
        );
        operation.throwIfAborted();
        const ids =
          retryKind === "delta"
            ? []
            : accepted.artifactIds.length
              ? accepted.artifactIds.slice(0, ARTIFACT_SYNC_LIMITS.currentRows)
              : requested && retryKind !== "current"
                ? []
                : [...dirty].slice(0, ARTIFACT_SYNC_LIMITS.currentRows);
        if (ids.length) {
          for (const id of ids) dirty.delete(id);
          try {
            await reconcileArtifactCurrent(
              reader,
              entry.collection,
              entry.definition.type,
              ids,
              operation,
              { reportFailure: retry >= 3 },
            );
            await accepted.complete(ids, operation);
          } catch (error) {
            for (const id of ids) {
              if (dirty.size < 1000) dirty.add(id);
              else requested = true;
            }
            throw error;
          }
        } else if (requested) {
          deltaWork = true;
          requested = false;
          await reconcileArtifactDelta(
            reader,
            entry.collection,
            entry.definition.type,
            operation,
            { reportFailure: retry >= 3 },
          );
        } else return;
        retry = 0;
        retryKind = undefined;
        notBefore = 0;
        if (ids.length)
          queueMicrotask(() => {
            if (!running) void pump();
          });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Artifact collection version changed"
        ) {
          if (syncing) group.entries.delete(syncing);
          if (!group.entries.size) {
            group.lifetime.abort();
            if (groups.get(group.key) === group) groups.delete(group.key);
          } else {
            retry = 0;
            retryKind = undefined;
            requested = true;
          }
        } else if (!signal.aborted) {
          retry++;
          const permanent =
            error instanceof ArtifactSyncError &&
            ["sync_limit", "sync_invalid"].includes(error.code);
          requested ||= deltaWork;
          if (retry <= 3 && !permanent) {
            retryKind = deltaWork ? "delta" : "current";
            const delay = RECOVERY_DELAYS_MS[retry - 1] ?? REPAIR_MS;
            notBefore = Date.now() + delay;
            schedule(delay);
          } else {
            retryKind = undefined;
            notBefore = Date.now() + REPAIR_MS;
          }
        }
      } finally {
        finish();
        running = false;
        batch = undefined;
        if (!group.lifetime.signal.aborted) {
          if (retry === 0 && (requested || dirty.size)) void pump();
          else if (retry > 0 && !timer) schedule(REPAIR_MS, true);
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
            let changed = false;
            for (const event of events) {
              if (!hasEventProof(event)) continue;
              if (
                event.kind === 45010 &&
                [...group.entries].some((entry) =>
                  event.tags.some(
                    ([name, value]) =>
                      name === "type" && value === entry.definition.type,
                  ),
                )
              ) {
                const id = event.tags.find(([name]) => name === "d")?.[1];
                if (id && dirty.size < 1000) dirty.add(id);
                else requested = true;
                changed = true;
              } else if ([45011, 9005, 44100, 44101].includes(event.kind)) {
                requested = true;
                changed = true;
              }
            }
            if (changed && !running) {
              if (Date.now() < notBefore) schedule(notBefore - Date.now());
              else void pump();
            }
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
        retryKind = undefined;
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
      clearInterval(repair);
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
