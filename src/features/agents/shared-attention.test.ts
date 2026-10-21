import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import type { TimerWatch } from "./attention";
import {
  admitShared,
  finishShared,
  readSharedProgress,
  sharedDefinitionCurrent,
  sharedEventCandidate,
  sharedTimerCandidate as prepareTimer,
} from "./shared-attention";
import { sharedRelay } from "./shared-attention-testing";

const channel = "0b8e2a3c-1d4f-4a5b-8c6d-7e8f9a0b1c2d";
const definition = "0b8e2a3c-1d4f-4a5b-8c6d-7e8f9a0b1c2d";
const signal = () => AbortSignal.timeout(10_000);
afterEach(() => vi.useRealTimers());
async function sharedTimerCandidate(...args: Parameters<typeof prepareTimer>) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(args[2] * 1000);
  return prepareTimer(...args);
}
function present<T>(value: T | undefined): T {
  assert.isDefined(value);
  return value;
}
function setup() {
  const relay = sharedRelay();
  const key = generateSecretKey();
  const enabled = (active = true) =>
    finalizeEvent(
      {
        kind: 45010,
        created_at: 1000,
        tags: [
          ["h", channel],
          ["d", definition],
          ["type", "nexus.automation"],
          ["op", "create"],
        ],
        content: JSON.stringify({ id: definition, enabled: active }),
      },
      key,
    );
  const event = enabled();
  relay.heads.set(definition, event);
  const timer = {
    type: "timer",
    interest_id: "work",
    prompt: "Run",
    enabled: true,
    interval_secs: 60,
    armed_at: 1000,
    max_occurrences: null,
    expires_at: null,
    shared: {
      channel_id: channel,
      definition_id: definition,
      definition_revision: event.id,
    },
  } satisfies TimerWatch;
  return { relay, timer, enabled };
}

describe("shared admission", () => {
  it("admits one client, preserves consumption at restart and transfer, and waits a full interval", async () => {
    const { relay, timer } = setup();
    const a = relay.client();
    const b = relay.client();
    const first = present(await sharedTimerCandidate(a, timer, 1200, signal()));
    const second = present(
      await sharedTimerCandidate(b, timer, 1200, signal()),
    );
    expect(first.progress.occurrence).toEqual({
      id: "timer:1060",
      definition_revision: timer.shared.definition_revision,
      scheduled_at: 1060,
    });
    const admitted = await Promise.all([
      admitShared(a, first, signal()),
      admitShared(b, second, signal()),
    ]);
    expect(admitted.filter(Boolean)).toHaveLength(1);
    expect(
      await sharedTimerCandidate(relay.client(), timer, 1259, signal()),
    ).toBeUndefined();
    const next = present(
      await sharedTimerCandidate(relay.client(), timer, 1260, signal()),
    );
    expect(next.progress).toMatchObject({
      used: 2,
      next_due: 1320,
      occurrence: { id: "timer:1260", scheduled_at: 1260 },
    });
    expect(await readSharedProgress(b, timer.shared, signal())).toMatchObject({
      used: 1,
      result: "uncertain",
    });
    await finishShared(a, first, present(admitted[0]), "completed", signal());
    expect(await readSharedProgress(b, timer.shared, signal())).toMatchObject({
      result: "completed",
    });
  });
  it("never dispatches from an uncertain acceptance or replays it after restart", async () => {
    const { relay, timer } = setup();
    const a = relay.client();
    const candidate = present(
      await sharedTimerCandidate(a, timer, 1060, signal()),
    );
    relay.setUncertain(true);
    await expect(admitShared(a, candidate, signal())).rejects.toThrow(
      "Receipt connection closes",
    );
    relay.setUncertain(false);
    expect(
      await sharedTimerCandidate(relay.client(), timer, 1060, signal()),
    ).toBeUndefined();
    expect(await readSharedProgress(a, timer.shared, signal())).toMatchObject({
      result: "uncertain",
      used: 1,
    });
  });
  it("refuses an edited or disabled definition before admission", async () => {
    const { relay, timer, enabled } = setup();
    const a = relay.client();
    const candidate = present(
      await sharedTimerCandidate(a, timer, 1060, signal()),
    );
    relay.heads.set(definition, enabled(false));
    expect(await admitShared(a, candidate, signal())).toBeUndefined();
    expect(await sharedDefinitionCurrent(a, timer.shared, signal())).toBe(
      false,
    );
    expect(await readSharedProgress(a, timer.shared, signal())).toBeUndefined();
  });
  it("records a cancelled occurrence if disable follows consumption", async () => {
    const { relay, timer, enabled } = setup();
    const a = relay.client();
    const candidate = present(
      await sharedTimerCandidate(a, timer, 1060, signal()),
    );
    const accepted = present(await admitShared(a, candidate, signal()));
    relay.heads.set(definition, enabled(false));
    expect(await sharedDefinitionCurrent(a, timer.shared, signal())).toBe(
      false,
    );
    await finishShared(a, candidate, accepted, "cancelled", signal());
    expect(await readSharedProgress(a, timer.shared, signal())).toMatchObject({
      result: "cancelled",
    });
  });
  it("Run now consumes a stable request once and resets interval progress", async () => {
    const { relay, timer } = setup();
    const a = relay.client();
    const id = "10000000-0000-4000-8000-000000000001";
    const candidate = present(
      await sharedTimerCandidate(a, timer, 1010, signal(), id),
    );
    const accepted = present(await admitShared(a, candidate, signal(), id));
    await finishShared(a, candidate, accepted, "completed", signal());
    expect(
      await readSharedProgress(a, timer.shared, signal(), `manual:${id}`),
    ).toMatchObject({ result: "completed" });
    expect(
      await sharedTimerCandidate(a, timer, 1069, signal()),
    ).toBeUndefined();
    const later = present(await sharedTimerCandidate(a, timer, 1070, signal()));
    expect(await admitShared(a, later, signal())).toBeDefined();
    const retry = present(
      await sharedTimerCandidate(a, timer, 1080, signal(), id),
    );
    expect(await admitShared(a, retry, signal(), id)).toBeUndefined();
    expect(await readSharedProgress(a, timer.shared, signal())).toMatchObject({
      used: 2,
      next_due: 1130,
    });
  });
  it("uses the current cron minute with absent or saved progress", async () => {
    const { relay, timer } = setup();
    const a = relay.client();
    const cron = { ...timer, cron_utc: "* * * * *" };
    const candidate = present(
      await sharedTimerCandidate(a, cron, 1250, signal()),
    );
    expect(candidate.progress.occurrence.scheduled_at).toBe(1200);
    expect(await admitShared(a, candidate, signal())).toBeDefined();
    expect(
      await sharedTimerCandidate(relay.client(), cron, 1259, signal()),
    ).toBeUndefined();
    const resumed = present(
      await sharedTimerCandidate(relay.client(), cron, 1501, signal()),
    );
    expect(resumed.progress.occurrence.scheduled_at).toBe(1500);
    expect(
      await sharedTimerCandidate(
        a,
        { ...cron, cron_utc: "0 * * * *" },
        1501,
        signal(),
      ),
    ).toBeUndefined();
  });
  it("deduplicates source events across machines and definition revisions", async () => {
    const { relay, timer, enabled } = setup();
    const a = relay.client();
    const b = relay.client();
    const source = enabled(false);
    const ca = await sharedEventCandidate(timer.shared, source);
    const cb = await sharedEventCandidate(timer.shared, source);
    expect(ca.progress.occurrence.id).toBe(source.id);
    expect(await admitShared(a, ca, signal())).toBeDefined();
    expect(await admitShared(b, cb, signal())).toBeUndefined();
    expect(await admitShared(relay.client(), cb, signal())).toBeUndefined();
  });
  it("does not replace newer progress with an old completion", async () => {
    const { relay, timer } = setup();
    const a = relay.client();
    const first = present(await sharedTimerCandidate(a, timer, 1060, signal()));
    const accepted = present(await admitShared(a, first, signal()));
    const next = present(await sharedTimerCandidate(a, timer, 1120, signal()));
    await admitShared(a, next, signal());
    await finishShared(a, first, accepted, "completed", signal());
    expect(await readSharedProgress(a, timer.shared, signal())).toMatchObject({
      used: 2,
      result: "uncertain",
    });
  });
  it("cancels a manual request when another admission advances timer progress", async () => {
    const { relay, timer } = setup();
    const a = relay.client();
    const manual = present(
      await sharedTimerCandidate(
        a,
        timer,
        1060,
        signal(),
        "10000000-0000-4000-8000-000000000002",
      ),
    );
    const scheduled = present(
      await sharedTimerCandidate(a, timer, 1060, signal()),
    );
    await admitShared(a, scheduled, signal());
    expect(
      await admitShared(
        a,
        manual,
        signal(),
        "10000000-0000-4000-8000-000000000002",
      ),
    ).toBeUndefined();
    expect(
      await readSharedProgress(
        a,
        timer.shared,
        signal(),
        "manual:10000000-0000-4000-8000-000000000002",
      ),
    ).toMatchObject({ result: "cancelled" });
  });
  it("sets the next interval after a delayed definition read", async () => {
    const { relay, timer } = setup();
    const io = relay.client();
    const candidate = present(
      await sharedTimerCandidate(io, timer, 1060, signal()),
    );
    vi.setSystemTime(1090_000);
    const accepted = present(await admitShared(io, candidate, signal()));
    expect(await readSharedProgress(io, timer.shared, signal())).toMatchObject({
      next_due: 1150,
    });
    await finishShared(io, candidate, accepted, "completed", signal());
    expect(await readSharedProgress(io, timer.shared, signal())).toMatchObject({
      next_due: 1150,
    });
  });
  it("preserves usage and applies a changed arm time to shared progress", async () => {
    const { relay, timer } = setup();
    const io = relay.client();
    const first = present(
      await sharedTimerCandidate(io, timer, 1060, signal()),
    );
    await admitShared(io, first, signal());
    const rearmed = { ...timer, armed_at: 1100 };
    expect(
      await sharedTimerCandidate(io, rearmed, 1120, signal()),
    ).toBeUndefined();
    const second = present(
      await sharedTimerCandidate(io, rearmed, 1160, signal()),
    );
    expect(second.progress).toMatchObject({
      used: 2,
      occurrence: { scheduled_at: 1160 },
    });
  });
  it("does not read shared cron state outside a matching minute", async () => {
    const { relay, timer } = setup();
    const io = relay.client();
    expect(
      await sharedTimerCandidate(
        io,
        { ...timer, cron_utc: "0 * * * *" },
        1060,
        signal(),
      ),
    ).toBeUndefined();
    expect(io.read).not.toHaveBeenCalled();
  });
});
