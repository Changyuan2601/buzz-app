import { expect, it, vi } from "vitest";
import {
  type BackupStatus,
  createBackupStatus,
  handoffBackupSession,
} from "./backup";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(public onmessage: (response: unknown) => void) {}
  },
}));

type Send = Parameters<typeof createBackupStatus>[0];
type Watcher = { onmessage: (status: BackupStatus) => void };
const at = (
  seq: number,
  pass: number,
  status: "idle" | "running" | "complete",
): BackupStatus => ({ seq, pass, builderlab: true, status });

function native() {
  const watchers: Watcher[] = [];
  let state = (): Promise<BackupStatus> => Promise.resolve(at(1, 0, "idle"));
  let watch = (): Promise<void> => Promise.resolve();
  const send = vi.fn(
    async (
      command: string,
      args?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (command === "nsec_backup_watch") {
        watchers.push(args?.onEvent as Watcher);
        return watch();
      }
      if (command === "nsec_backup_state") return state();
      throw new Error(`Unexpected command: ${command}`);
    },
  );
  return {
    send,
    store: () => createBackupStatus(send as Send),
    watchers,
    holdState(status: BackupStatus) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      state = () => held.then(() => status);
      return release;
    },
    failWatch(error: unknown) {
      watch = () => Promise.reject(error);
      return () => {
        watch = () => Promise.resolve();
      };
    },
  };
}

it("registers nothing until read, then watches before reading the snapshot", async () => {
  const host = native();
  const store = host.store();
  expect(store.snapshot()).toBeUndefined();
  expect(host.send).not.toHaveBeenCalled();

  const listener = vi.fn();
  store.subscribe(listener);
  await expect(store.ready()).resolves.toEqual(at(1, 0, "idle"));
  expect(host.send.mock.calls).toEqual([
    ["nsec_backup_watch", { onEvent: host.watchers[0] }],
    ["nsec_backup_state"],
  ]);
  expect(listener).toHaveBeenCalledTimes(1);

  host.watchers[0]?.onmessage(at(2, 1, "running"));
  expect(store.snapshot()).toEqual(at(2, 1, "running"));
  await expect(store.ready()).resolves.toEqual(at(2, 1, "running"));
  expect(host.send).toHaveBeenCalledTimes(2);
  expect(listener).toHaveBeenCalledTimes(2);
});

it("keeps the higher seq whether the older status arrives on the channel or in the snapshot", async () => {
  const host = native();
  const release = host.holdState(at(4, 2, "running"));
  const store = host.store();
  const listener = vi.fn();
  store.subscribe(listener);
  const ready = store.ready();
  await vi.waitFor(() =>
    expect(host.send).toHaveBeenCalledWith("nsec_backup_state"),
  );

  // Published after the watch registered, delivered before the snapshot reply.
  host.watchers[0]?.onmessage(at(5, 2, "complete"));
  release();
  await expect(ready).resolves.toEqual(at(5, 2, "complete"));
  expect(listener).toHaveBeenCalledTimes(1);

  host.watchers[0]?.onmessage(at(5, 3, "running"));
  host.watchers[0]?.onmessage(at(3, 3, "running"));
  expect(store.snapshot()).toEqual(at(5, 2, "complete"));
  expect(listener).toHaveBeenCalledTimes(1);
});

it("registers again after a failed watch", async () => {
  const host = native();
  const refused = new Error("Backup status belongs to the main window");
  const recover = host.failWatch(refused);
  const store = host.store();
  await expect(store.ready()).rejects.toBe(refused);
  expect(host.send).toHaveBeenCalledTimes(1);

  recover();
  await expect(store.ready()).resolves.toEqual(at(1, 0, "idle"));
  expect(host.watchers).toHaveLength(2);
  expect(host.watchers[1]).not.toBe(host.watchers[0]);
  host.watchers[1]?.onmessage(at(2, 1, "running"));
  expect(store.snapshot()).toEqual(at(2, 1, "running"));
});

it("silences the channel and its listeners on dispose", async () => {
  const host = native();
  const store = host.store();
  const listener = vi.fn();
  store.subscribe(listener);
  await store.ready();
  const watcher = host.watchers[0];
  store.dispose();

  watcher?.onmessage(at(2, 1, "running"));
  expect(store.snapshot()).toEqual(at(1, 0, "idle"));
  expect(listener).toHaveBeenCalledTimes(1);
});

it("resolves a handoff to its ticket, or null when none is issued or the handoff fails", async () => {
  const send =
    vi.fn<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >();
  const handoff = (credential: string | null) =>
    handoffBackupSession("builderlab", credential, send as Send);
  send.mockResolvedValueOnce(4);
  await expect(handoff("token")).resolves.toBe(4);
  send.mockResolvedValueOnce(null);
  await expect(handoff(null)).resolves.toBeNull();
  send.mockRejectedValueOnce(new Error("Unknown login source"));
  await expect(handoff("token")).resolves.toBeNull();
  expect(send).toHaveBeenNthCalledWith(1, "nsec_backup_session", {
    source: "builderlab",
    generation: expect.any(Number),
    credential: "token",
  });
});
