import { afterEach, expect, it, vi } from "vitest";
import { link, type Link } from "./link";
import { createLocalAgentActivity } from "./local-activity";
import { linkedActivity, serveActivity } from "./runner-link";

const open: Link[] = [];
afterEach(() => {
  for (const side of open.splice(0)) side.close();
});

function linked() {
  const activity = createLocalAgentActivity();
  const channel = new MessageChannel();
  const runner = link(channel.port1, serveActivity(activity.reader));
  const manager = link(channel.port2);
  open.push(runner, manager);
  return { activity, source: linkedActivity(manager).source };
}

const request = {
  scope: "wss://relay.example",
  agent: "a".repeat(64),
  channelId: "channel",
  messageId: "message",
  threadRootId: "message",
};

it("shows the Runner's local work, and keeps rows until they change", async () => {
  const { activity, source } = linked();
  const heard = vi.fn();
  source.subscribeWork(heard);
  const work = activity.begin(request);
  work.started();
  work.step("Read", "notes.md");
  await vi.waitFor(() =>
    expect(source.work()).toMatchObject([
      { ...request, state: "working", step: { tool: "Read" } },
    ]),
  );
  const rows = source.work();
  expect(Object.isFrozen(rows[0])).toBe(true);
  heard.mockClear();
  // A step with the same text is no change, so nothing is sent.
  work.step("Read", "notes.md");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(heard).not.toHaveBeenCalled();
  expect(source.work()).toBe(rows);
});

it("stops a turn and hides an error through the Runner", async () => {
  const { activity, source } = linked();
  const stop = vi.fn(async () => {});
  const running = activity.begin(request);
  running.started();
  running.interruptible(stop);
  await vi.waitFor(() =>
    expect(source.work()).toMatchObject([{ stoppable: true }]),
  );
  await source.interrupt?.(request);
  expect(stop).toHaveBeenCalledTimes(1);
  await vi.waitFor(() =>
    expect(source.work()).toMatchObject([{ state: "stopped" }]),
  );

  const failed = activity.begin({ ...request, messageId: "other" });
  failed.finish({ ok: false, error: "No credits left" });
  await vi.waitFor(() =>
    expect(source.work()).toContainEqual(
      expect.objectContaining({ messageId: "other", state: "error" }),
    ),
  );
  source.dismissError?.({ ...request, messageId: "other" });
  await vi.waitFor(() =>
    expect(source.work()).toContainEqual(
      expect.objectContaining({ messageId: "other", dismissed: true }),
    ),
  );
});
