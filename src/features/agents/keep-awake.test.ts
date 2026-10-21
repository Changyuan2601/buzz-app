import { expect, it, vi } from "vitest";
import {
  createKeepAwake,
  type KeepAwakePlatform,
  type PowerState,
} from "./keep-awake";

function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  let changed = (_state: PowerState) => {};
  let fail = false;
  let gate: Promise<void> | undefined;
  const platform: KeepAwakePlatform = {
    open: vi.fn(async (listener) => {
      changed = listener;
      return 1;
    }),
    set: vi.fn(async (_lease, active) => {
      await gate;
      if (fail) throw new Error("Power service unavailable");
      return { supported: true, active, expired: false };
    }),
  };
  const service = createKeepAwake(platform, storage);
  return {
    service,
    platform,
    storage,
    values,
    changed: (state: PowerState) => changed(state),
    fail: (value: boolean) => {
      fail = value;
    },
    gate: (value?: Promise<void>) => {
      gate = value;
    },
  };
}

it("defaults off, persists the choice, and keeps the assertion until all local execution ends", async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.service.snapshot().pending).toBe(false));
  expect(f.service.snapshot().enabled).toBe(false);
  const first = new AbortController();
  const a = f.service.begin(first.signal);
  f.service.setEnabled(true);
  await vi.waitFor(() => expect(f.service.snapshot().active).toBe(true));
  const b = f.service.begin(new AbortController().signal);
  a.finish();
  await vi.waitFor(() => expect(f.service.snapshot().pending).toBe(false));
  expect(f.service.snapshot().active).toBe(true);
  b.finish();
  await vi.waitFor(() => expect(f.service.snapshot().active).toBe(false));
  expect(f.values.get("buzz-agent-keep-awake.v1")).toBe("on");
  const restored = createKeepAwake(f.platform, f.storage);
  expect(restored.snapshot().enabled).toBe(true);
  await restored.dispose();
  await f.service.dispose();
});

it("serializes pending acquisition with disable and retirement, ignores stale activity, and releases on disposal", async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.service.snapshot().pending).toBe(false));
  f.service.setEnabled(true);
  await vi.waitFor(() => expect(f.service.snapshot().pending).toBe(false));
  let release!: () => void;
  f.gate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const controller = new AbortController();
  const work = f.service.begin(controller.signal);
  f.service.setEnabled(true);
  await vi.waitFor(() =>
    expect(f.platform.set).toHaveBeenLastCalledWith(1, true),
  );
  f.service.setEnabled(false);
  controller.abort();
  try {
    expect(f.service.snapshot().working).toBe(false);
  } finally {
    f.gate();
    release();
  }
  await vi.waitFor(() => expect(f.service.snapshot().pending).toBe(false));
  expect(f.service.snapshot().active).toBe(false);
  const calls = vi.mocked(f.platform.set).mock.calls.length;
  work.pulse();
  work.finish();
  expect(vi.mocked(f.platform.set).mock.calls).toHaveLength(calls);
  f.service.setEnabled(true);
  f.service.begin(new AbortController().signal);
  await vi.waitFor(() => expect(f.service.snapshot().active).toBe(true));
  await f.service.dispose();
  expect(f.platform.set).toHaveBeenLastCalledWith(1, false);
});

it("native expiry stays paused until real new activity and failures require an observable retry", async () => {
  const f = fixture();
  f.service.setEnabled(true);
  const work = f.service.begin(new AbortController().signal);
  await vi.waitFor(() => expect(f.service.snapshot().active).toBe(true));
  f.changed({ supported: true, active: false, expired: true });
  expect(f.service.snapshot().expired).toBe(true);
  work.pulse();
  await vi.waitFor(() => expect(f.service.snapshot().active).toBe(true));
  f.fail(true);
  work.pulse();
  await vi.waitFor(() =>
    expect(f.service.snapshot().error).toBe("Power service unavailable"),
  );
  f.fail(false);
  f.service.retry();
  await vi.waitFor(() => expect(f.service.snapshot().error).toBeNull());
  expect(f.service.snapshot().active).toBe(true);
  f.storage.setItem.mockImplementationOnce(() => {
    throw new Error("Disk full");
  });
  f.service.setEnabled(false);
  expect(f.service.snapshot().saveError).toContain("could not be saved");
  expect(f.service.snapshot().enabled).toBe(false);
  await vi.waitFor(() => expect(f.service.snapshot().active).toBe(false));
  f.service.retry();
  expect(f.values.get("buzz-agent-keep-awake.v1")).toBe("off");
  expect(f.service.snapshot().saveError).toBeNull();
  await f.service.dispose();
});

it("does not acquire when unsupported or when an unreadable preference cannot establish consent", async () => {
  const platform: KeepAwakePlatform = {
    open: async () => 1,
    set: vi.fn(async () => ({
      supported: false,
      active: false,
      expired: false,
    })),
  };
  const service = createKeepAwake(platform, {
    getItem: () => {
      throw new Error("Storage denied");
    },
    setItem: () => {},
  });
  service.begin(new AbortController().signal);
  await vi.waitFor(() => expect(service.snapshot().pending).toBe(false));
  expect(service.snapshot()).toMatchObject({
    enabled: false,
    supported: false,
    active: false,
  });
  service.setEnabled(true);
  expect(service.snapshot().enabled).toBe(false);
  expect(platform.set).not.toHaveBeenCalledWith(1, true);
  await service.dispose();
});

it("survives denied access to the localStorage property itself and offers save recovery", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("Storage property denied");
    },
  });
  const platform: KeepAwakePlatform = {
    open: async () => 1,
    set: async (_lease, active) => ({
      supported: true,
      active,
      expired: false,
    }),
  };
  try {
    const service = createKeepAwake(platform);
    expect(service.snapshot().enabled).toBe(false);
    service.setEnabled(true);
    expect(service.snapshot().saveError).toContain("could not be saved");
    await service.dispose();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
