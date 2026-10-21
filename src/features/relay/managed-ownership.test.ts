import { afterEach, expect, it, vi } from "vitest";
import { registerManagedDelivery } from "./managed-delivery";

afterEach(() => vi.unstubAllGlobals());
it("keeps separate outbox owners until each retained session closes", async () => {
  const requests: Promise<unknown>[] = [];
  vi.stubGlobal("navigator", {
    locks: {
      request: vi.fn((_name, _options, run) => {
        const work = Promise.resolve().then(run);
        requests.push(work);
        return work;
      }),
    },
  });
  const a = { owner: vi.fn(async () => {}), receive: vi.fn(async () => {}) };
  const b = { owner: vi.fn(async () => {}), receive: vi.fn(async () => {}) };
  const stopA = registerManagedDelivery("community-a", a);
  const stopB = registerManagedDelivery("community-b", b);
  await vi.waitFor(() => {
    expect(a.owner).toHaveBeenCalledWith(true);
    expect(b.owner).toHaveBeenCalledWith(true);
  });
  stopB();
  await vi.waitFor(() => expect(b.owner).toHaveBeenLastCalledWith(false));
  expect(a.owner).not.toHaveBeenCalledWith(false);
  stopA();
  await Promise.all(requests);
  expect(a.owner).toHaveBeenLastCalledWith(false);
});
