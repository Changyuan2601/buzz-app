import { expect, it, vi } from "vitest";
import { archiveClient } from "./client";

it("successful deletion does not depend on a subsequent settings read", async () => {
  const request = vi.fn(async (input: { action: string }) => {
    if (input.action === "clear") return { cleared: true };
    throw new Error("settings unavailable");
  });
  const { host } = archiveClient("device", request);
  await expect(host.clear(24200)).resolves.toBeUndefined();
  expect(request).toHaveBeenCalledWith({
    action: "clear",
    kind: 24200,
  });
  await expect(host.settings(new AbortController().signal)).rejects.toThrow(
    "settings unavailable",
  );
});

it("failed deletion still rejects", async () => {
  const { host } = archiveClient("device", async () => {
    throw new Error("disk");
  });
  await expect(host.clear(24200)).rejects.toThrow("disk");
});

it("clear refreshes the durable revision before the next native capture", async () => {
  let revision = 0;
  const client = archiveClient("device", async ({ action }) => {
    if (action === "clear") return { cleared: ++revision };
    return {
      observer: true,
      metrics: true,
      observerDays: 30,
      revision,
      location: "device",
      path: "/fixture.sqlite3",
      bytes: 0,
    };
  });
  const listener = vi.fn();
  client.subscribe(listener);
  await client.host.settings(new AbortController().signal);
  expect(client.current()?.revision).toBe(0);
  await client.host.clear(24200);
  expect(client.current()?.revision).toBe(1);
  expect(listener).toHaveBeenLastCalledWith(
    expect.objectContaining({ revision: 1 }),
  );
});
