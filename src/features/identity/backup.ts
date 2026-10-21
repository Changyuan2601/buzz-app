import { Channel, invoke } from "@tauri-apps/api/core";

type Send = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

// Shared by both login owners so re-enabling a plugin cannot reuse an old revision.
let generation = 0;
/** Resolves to the ticket of the backup pass this handoff starts, or `null` when
 * none will (or the handoff was refused). Never rejects. */
export function handoffBackupSession(
  source: "builderlab" | "hosted",
  credential: string | null,
  send: Send = invoke,
): Promise<number | null> {
  return send<unknown>("nsec_backup_session", {
    source,
    generation: ++generation,
    credential,
  }).then(
    (ticket) => (typeof ticket === "number" ? ticket : null),
    () => null,
  );
}

/** What the native uploader last did for this device's key. `seq` orders
 * statuses; a pass numbered at or above a handoff's ticket started after it. */
export type BackupStatus = Readonly<
  { seq: number; pass: number; builderlab: boolean } & (
    | { status: "idle" | "running" | "complete" }
    | { status: "waiting"; reason: "no_consent" | "no_session" | "not_linked" }
    | {
        status: "failed";
        kind:
          | "busy"
          | "signed_out"
          | "not_offered"
          | "other_key_linked"
          | "invalid_service"
          | "refused"
          | "unreachable"
          | "unconfirmed"
          | "storage";
      }
  )
>;

/** Nothing is registered until the first `subscribe` or `ready()`. The channel is
 * watched before the snapshot is read and the higher `seq` wins, so a transition
 * between the two is never lost. */
export function createBackupStatus(send: Send = invoke) {
  let status: BackupStatus | undefined;
  let started: Promise<void> | undefined;
  let channel: Channel<BackupStatus> | undefined;
  const listeners = new Set<() => void>();
  const accept = (next: BackupStatus) => {
    if (status && next.seq <= status.seq) return;
    status = next;
    for (const listener of listeners) listener();
  };
  function register() {
    channel = new Channel<BackupStatus>(accept);
    const attempt = send("nsec_backup_watch", { onEvent: channel })
      .then(() => send<BackupStatus>("nsec_backup_state"))
      .then(accept);
    attempt.catch(() => {
      // The next reader registers again.
      if (started === attempt) started = undefined;
    });
    return attempt;
  }
  /** Resolves with the current status once the watcher is registered. */
  function ready() {
    started ??= register();
    // The snapshot has been accepted, so a status is held.
    return started.then(() => status as BackupStatus);
  }
  return {
    snapshot: () => status,
    ready,
    subscribe(listener: () => void) {
      listeners.add(listener);
      void ready().catch(() => {});
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (channel) channel.onmessage = () => {};
      listeners.clear();
    },
  };
}
