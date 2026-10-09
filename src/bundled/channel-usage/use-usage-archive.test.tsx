// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ArchiveHost,
  ArchivePage,
  ArchiveSettings,
} from "../../features/archive/types";
import { useUsageArchive } from "./use-usage-archive";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const settings: ArchiveSettings = {
  observer: true,
  metrics: true,
  observerDays: 30,
  revision: 1,
  location: "device",
  path: "isolated",
  bytes: 0,
};
const frame = (
  n: number,
  channelId: string,
): ArchivePage["records"][number] => ({
  id: n.toString(16).padStart(64, "0"),
  agent: "1".repeat(64),
  createdAt: n,
  receivedAt: n,
  plaintext: JSON.stringify({
    harness: "goose",
    timestamp: new Date(n * 1000).toISOString(),
    sessionId: "s",
    turnId: String(n),
    turnSeq: n,
    channelId,
    turn: { inputTokens: n },
  }),
});
const page = (
  records: ArchivePage["records"],
  before: number | null,
  revision = 1,
): ArchivePage => ({ records, agents: [], before, skipped: 0, revision });
function fixture() {
  const reads: Array<ReturnType<typeof deferred<ArchivePage>>> = [];
  const host: ArchiveHost = {
    location: "device",
    settings: vi.fn(async () => settings),
    configure: vi.fn(async () => settings),
    clear: vi.fn(async () => {}),
    read: vi.fn(() => {
      const operation = deferred<ArchivePage>();
      reads.push(operation);
      return operation.promise;
    }),
  };
  return { host, reads };
}
afterEach(cleanup);
function Probe({
  host,
  channel = "one",
  allowed = true,
}: {
  host: ArchiveHost;
  channel?: string;
  allowed?: boolean;
}) {
  const usage = useUsageArchive(host, channel, allowed);
  return (
    <section>
      <output>
        {usage.status}:{usage.groups.length}:
        {usage.partial ? "partial" : "done"}:{usage.skipped}:{usage.unreadable}
      </output>
      <button type="button" onClick={usage.refresh}>
        Refresh
      </button>
    </section>
  );
}
it("automatically pages past an unrelated first page and retains the selected channel", async () => {
  const { host, reads } = fixture();
  render(<Probe host={host} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(reads).toHaveLength(1);
  await act(async () => reads[0]?.resolve(page([frame(1, "other")], 100)));
  expect(screen.getByText("loading:0:done:0:0")).toBeTruthy();
  await act(async () => {
    await Promise.resolve();
  });
  expect(reads).toHaveLength(2);
  await act(async () =>
    reads[1]?.resolve(page([frame(2, "one"), frame(2, "one")], null)),
  );
  expect(screen.getByText("ready:1:done:0:0")).toBeTruthy();
  expect(host.read).toHaveBeenLastCalledWith(
    { kind: 44200, before: 100 },
    expect.any(AbortSignal),
  );
});
it("fences pending reads on channel retarget, revoked access, and disposal", async () => {
  const { host, reads } = fixture();
  const result = render(<Probe host={host} />);
  await act(async () => {
    await Promise.resolve();
  });
  result.rerender(<Probe host={host} channel="two" />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => reads[0]?.resolve(page([frame(1, "one")], null)));
  expect(screen.getByText("loading:0:done:0:0")).toBeTruthy();
  result.rerender(<Probe host={host} channel="two" allowed={false} />);
  await act(async () => reads[1]?.resolve(page([frame(2, "two")], null)));
  expect(screen.getByText("unavailable:0:done:0:0")).toBeTruthy();
  result.unmount();
});
it("shows read errors, recovers on refresh, and fences a changed archive revision", async () => {
  const { host, reads } = fixture();
  render(<Probe host={host} />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => reads[0]?.reject(new Error("read failed")));
  expect(screen.getByText("error:0:done:0:0")).toBeTruthy();
  await act(async () => {
    screen.getByText("Refresh").click();
    await Promise.resolve();
  });
  await act(async () => reads[1]?.resolve(page([frame(2, "one")], null, 2)));
  expect(screen.getByText("error:0:done:0:0")).toBeTruthy();
  await act(async () => {
    screen.getByText("Refresh").click();
    await Promise.resolve();
  });
  await act(async () => reads[2]?.resolve(page([frame(3, "one")], null)));
  expect(screen.getByText("ready:1:done:0:0")).toBeTruthy();
});
it("discards old revision before the next fallible read", async () => {
  const { host, reads } = fixture();
  let settingsCalls = 0;
  host.settings = vi.fn(async () => ({
    ...settings,
    revision: ++settingsCalls >= 3 ? 2 : 1,
  }));
  render(<Probe host={host} />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => reads[0]?.resolve(page([frame(1, "one")], 100)));
  expect(screen.getByText("error:0:done:0:0")).toBeTruthy();
  expect(reads).toHaveLength(1);
});
it("discards old revision immediately when the next page changes, without awaiting trailing settings", async () => {
  const { host, reads } = fixture();
  let settingsCalls = 0;
  host.settings = vi.fn(async () => {
    settingsCalls++;
    if (settingsCalls === 4)
      throw new Error("trailing settings must not be called");
    return settings;
  });
  render(<Probe host={host} />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => reads[0]?.resolve(page([frame(1, "one")], 100)));
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => reads[1]?.resolve(page([], null, 2)));
  expect(screen.getByText("error:0:done:0:0")).toBeTruthy();
  expect(settingsCalls).toBe(3);
});
it("marks host-skipped and invalid channel payloads as incomplete", async () => {
  const { host, reads } = fixture();
  render(<Probe host={host} />);
  await act(async () => {
    await Promise.resolve();
  });
  const invalid = {
    ...frame(1, "one"),
    plaintext: JSON.stringify({
      channelId: "one",
      harness: "goose",
      timestamp: "invalid",
    }),
  };
  await act(async () =>
    reads[0]?.resolve({ ...page([invalid], null), skipped: 1 }),
  );
  expect(screen.getByText("ready:0:done:1:1")).toBeTruthy();
});

it("stops automatic scanning at the cap even when pages contain only unreadable records", async () => {
  const { host } = fixture();
  host.read = vi.fn(async ({ before }) => ({
    ...page([], (before ?? 2000) - 100),
    skipped: 100,
  }));
  render(<Probe host={host} />);
  expect(await screen.findByText("ready:0:partial:2000:0")).toBeTruthy();
  expect(host.read).toHaveBeenCalledTimes(20);
});
it("does not claim completeness after a later page fails, and refresh restarts at the newest page", async () => {
  const { host, reads } = fixture();
  render(<Probe host={host} />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => reads[0]?.resolve(page([frame(1, "one")], 100)));
  await act(async () => reads[1]?.reject(new Error("page failed")));
  expect(screen.getByText("error:0:done:0:0")).toBeTruthy();
  await act(async () => {
    screen.getByText("Refresh").click();
    await Promise.resolve();
  });
  expect(host.read).toHaveBeenLastCalledWith(
    { kind: 44200 },
    expect.any(AbortSignal),
  );
  await act(async () => reads[2]?.resolve(page([frame(2, "one")], null)));
  expect(screen.getByText("ready:1:done:0:0")).toBeTruthy();
});
