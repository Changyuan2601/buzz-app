// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ArchiveSettings } from "./ArchiveSettings";
import type {
  ArchiveHost,
  ArchiveSettings as Preferences,
} from "../features/archive/types";
import type { RelayData, RelaySnapshot } from "../features/relay/service";
import { createRelaySession } from "../features/relay/session";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function host(location: "device" | "broker" = "device") {
  const settings: Preferences = {
    observer: true,
    metrics: true,
    observerDays: 30,
    revision: 0,
    location,
    path: `/${location}/events.sqlite3`,
    bytes: 1024 * 1024,
  };
  const value: ArchiveHost = {
    location,
    settings: vi.fn(async () => settings),
    configure: vi.fn(async (next) => ({
      ...next,
      revision: next.revision + 1,
    })),
    clear: vi.fn(async () => {}),
    read: vi.fn(),
  };
  return { value, settings };
}
function fixture(initial: ArchiveHost) {
  const owner = createRelaySession(null);
  const snapshot = (host: ArchiveHost, generation: number): RelaySnapshot => ({
    status: "ready",
    scope: `community-${generation}`,
    generation,
    session: {
      ...owner.session,
      agentActivity: {
        ...owner.session.agentActivity,
        archive: host,
        clearHistory: () => host.clear(24200),
      },
    },
  });
  let current = snapshot(initial, 1);
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clearCache: vi.fn(),
    disconnect: vi.fn(),
    retry: vi.fn(),
  };
  return {
    relay,
    dispose: owner.dispose,
    select(next: ArchiveHost) {
      current = snapshot(next, current.generation + 1);
      for (const listener of listeners) listener();
    },
  };
}
afterEach(cleanup);
it("Personal space makes no host request or assumed capture switch", () => {
  const h = host(),
    f = fixture(h.value);
  render(<ArchiveSettings relay={f.relay} active />);
  expect(screen.getByText(/Select a community/)).toBeVisible();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(h.value.settings).not.toHaveBeenCalled();
  f.dispose();
});
it("unknown/read failure has no switches; retry reports location, size, community and independent metrics", async () => {
  const h = host("broker"),
    f = fixture(h.value),
    read = deferred<Preferences>();
  vi.mocked(h.value.settings).mockReturnValueOnce(read.promise);
  render(<ArchiveSettings relay={f.relay} community="Alpha" active />);
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  await act(async () => read.reject(new Error("disk")));
  expect(screen.getByRole("alert")).toHaveTextContent("Could not read");
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Reload archive settings" }),
  );
  expect(
    await screen.findByRole("switch", { name: "Save agent activity" }),
  ).toBeChecked();
  expect(screen.getByRole("heading", { name: /Alpha/ })).toBeVisible();
  expect(screen.getByText("/broker/events.sqlite3")).toBeVisible();
  expect(screen.getByText(/1.0 MiB/)).toBeVisible();
  expect(screen.getByText(/not in this browser/)).toBeVisible();
  vi.mocked(h.value.configure).mockRejectedValueOnce(new Error("conflict"));
  await userEvent.click(
    screen.getByRole("switch", { name: "Save agent activity" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
  expect(
    screen.getByRole("switch", { name: "Save agent activity" }),
  ).toBeChecked();
  f.dispose();
});
it.each(["save", "clear"])(
  "a pending %s cannot land on a newly selected community",
  async (action) => {
    const first = host(),
      second = host("broker"),
      f = fixture(first.value);
    const pending = deferred<Preferences>();
    const clearing = deferred<void>();
    vi.mocked(first.value.configure).mockReturnValueOnce(pending.promise);
    vi.mocked(first.value.clear).mockReturnValueOnce(clearing.promise);
    const view = render(
      <ArchiveSettings relay={f.relay} community="Alpha" active />,
    );
    await screen.findByRole("switch", { name: "Save agent activity" });
    if (action === "save")
      await userEvent.click(
        screen.getByRole("switch", { name: "Save agent activity" }),
      );
    else {
      await userEvent.click(
        screen.getByRole("button", { name: "Clear activity history" }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Clear saved records" }),
      );
    }
    act(() => f.select(second.value));
    view.rerender(<ArchiveSettings relay={f.relay} community="Beta" active />);
    await screen.findByText("/broker/events.sqlite3");
    await act(async () => {
      pending.resolve({ ...first.settings, observer: false });
      clearing.reject(new Error("old request failed"));
      if (action === "save") await clearing.promise.catch(() => {});
    });
    expect(
      screen.getByRole("switch", { name: "Save agent activity" }),
    ).toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(second.value.clear).not.toHaveBeenCalled();
    expect(second.value.configure).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: /Beta/ })).toBeVisible();
    f.dispose();
  },
);
it("clear failure remains explicit and does not report an empty archive", async () => {
  const h = host(),
    f = fixture(h.value);
  vi.mocked(h.value.clear).mockRejectedValueOnce(new Error("denied"));
  render(<ArchiveSettings relay={f.relay} community="Alpha" active />);
  await screen.findByRole("switch", { name: "Save agent activity" });
  await userEvent.click(
    screen.getByRole("button", { name: "Clear turn metrics" }),
  );
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Alpha");
  await userEvent.click(
    screen.getByRole("button", { name: "Clear saved records" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Could not clear"),
  );
  expect(screen.getByText(/1.0 MiB/)).toBeVisible();
  expect(h.value.clear).toHaveBeenCalledWith(44200);
  f.dispose();
});

it("successful clear reports refresh failure without claiming deletion failed", async () => {
  const h = host(),
    f = fixture(h.value);
  render(<ArchiveSettings relay={f.relay} community="Alpha" active />);
  await screen.findByRole("switch", { name: "Save agent activity" });
  vi.mocked(h.value.settings).mockRejectedValueOnce(new Error("read failed"));
  await userEvent.click(
    screen.getByRole("button", { name: "Clear activity history" }),
  );
  expect(h.value.clear).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Clear saved records" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Records cleared, but archive settings could not be refreshed",
  );
  expect(h.value.clear).toHaveBeenCalledWith(24200);
  f.dispose();
});
