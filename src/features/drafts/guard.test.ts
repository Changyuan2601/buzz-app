import { expect, it, vi } from "vitest";
import { createDraftGuard } from "./guard";

it("allows clean exits, scopes prompts and discards only the affected editors", async () => {
  const guard = createDraftGuard();
  expect(await guard.request()).toBe(true);
  const first = {},
    second = {};
  const reset = vi.fn(),
    otherReset = vi.fn();
  const editor = guard.register(first, "instructions", reset);
  guard
    .register(second, "model", otherReset)
    .update({ dirty: true, saving: false });
  expect(await guard.request(first)).toBe(true);
  editor.update({ dirty: true, saving: false });
  const leave = guard.request(first);
  expect(guard.snapshot()).toEqual({ label: "instructions", saving: false });
  guard.discard();
  expect(await leave).toBe(true);
  expect(reset).toHaveBeenCalledOnce();
  expect(otherReset).not.toHaveBeenCalled();
});

it("cancel preserves edits and repeated navigation cannot replace or stack a prompt", async () => {
  const guard = createDraftGuard();
  const reset = vi.fn();
  guard
    .register({}, "instructions", reset)
    .update({ dirty: true, saving: false });
  const original = guard.request();
  expect(await guard.request()).toBe(false);
  guard.cancel();
  expect(await original).toBe(false);
  expect(reset).not.toHaveBeenCalled();
  expect(guard.hasRisk()).toBe(true);
});

it("does not discard while saving, including after the dirty flag clears", async () => {
  const guard = createDraftGuard();
  const reset = vi.fn();
  const editor = guard.register({}, "settings", reset);
  editor.update({ dirty: false, saving: true });
  const leave = guard.request();
  expect(guard.snapshot()?.saving).toBe(true);
  guard.discard();
  expect(reset).not.toHaveBeenCalled();
  expect(guard.snapshot()).toBeDefined();
  editor.update({ dirty: false, saving: false });
  expect(await leave).toBe(false);
  expect(await guard.request()).toBe(true);
});

it.each(["change", "retire", "dispose"] as const)(
  "fences pending exit after %s",
  async (transition) => {
    const guard = createDraftGuard();
    const reset = vi.fn();
    const editor = guard.register({}, "instructions", reset);
    editor.update({ dirty: true, saving: false });
    const leave = guard.request();
    if (transition === "change") editor.update({ dirty: true, saving: true });
    else if (transition === "retire") editor.dispose();
    else guard.dispose();
    guard.discard();
    expect(await leave).toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(guard.snapshot()).toBeUndefined();
  },
);

it("withdraws a whole-page decision if a previously clean editor gains edits", async () => {
  const guard = createDraftGuard();
  const first = guard.register({}, "first", vi.fn());
  const reset = vi.fn();
  const second = guard.register({}, "second", reset);
  first.update({ dirty: true, saving: false });
  const leaving = guard.request();
  second.update({ dirty: true, saving: false });
  guard.discard();
  expect(await leaving).toBe(false);
  expect(reset).not.toHaveBeenCalled();
  expect(guard.hasRisk()).toBe(true);
});
