import { expect, it, vi } from "vitest";
import { afterFirstView, markPresented } from "./startup";

it("loads deferred plugin code only after the first view", async () => {
  const module = { apply() {} };
  const load = vi.fn(async () => module);
  const loading = afterFirstView(load)();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(load).not.toHaveBeenCalled();
  markPresented();
  await expect(loading).resolves.toBe(module);
  expect(load).toHaveBeenCalledOnce();
  // Later loads, such as a re-enable, do not wait again.
  await expect(afterFirstView(load)()).resolves.toBe(module);
});
