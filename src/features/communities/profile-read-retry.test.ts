import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inspectProfile } from "./api";
import { createRelaySession } from "../relay/session";
import { ReadError } from "../relay/errors";
import { keypair } from "../relay/testing";
import type { RelayEvent } from "../relay/events";

const owners: ReturnType<typeof createRelaySession>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(
      () =>
        controller.abort(
          new DOMException("Profile read timed out", "TimeoutError"),
        ),
      ms,
    );
    return controller.signal;
  });
});
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup() {
  const viewer = keypair();
  const query = vi.fn(async (): Promise<RelayEvent[]> => []);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    query,
    media: () => undefined,
  });
  owners.push(owner);
  return { owner, query };
}

it("keeps one session budget and the profile's twelve-second deadline", async () => {
  const h = setup();
  h.query.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    throw new ReadError("unavailable", "offline");
  });
  const pending = inspectProfile(
    "community",
    h.owner.session,
    new AbortController().signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({
    name: "TimeoutError",
  });
  await vi.advanceTimersByTimeAsync(12_000);
  await rejected;
  expect(h.query).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.query).toHaveBeenCalledTimes(3);
});

it("cancels profile backoff with the editor's signal", async () => {
  const h = setup();
  h.query.mockRejectedValue(new ReadError("unavailable", "offline"));
  const caller = new AbortController();
  const pending = inspectProfile("community", h.owner.session, caller.signal);
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await vi.advanceTimersByTimeAsync(0);
  caller.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(7000);
  expect(h.query).toHaveBeenCalledOnce();
});
