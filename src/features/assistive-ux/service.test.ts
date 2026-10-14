// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistiveUxService } from "./service";
import type { AssistiveFacts } from "./catalog";

const id = "threads.new-thread-placement";
const viewer = "a".repeat(64);
const facts: AssistiveFacts[typeof id] = {
  surface: "new-channel-thread",
  channelType: "stream",
  isMe: false,
};
const roots: Context[] = [];
function fixture() {
  const root = new Context();
  roots.push(root);
  return { root, service: new AssistiveUxService(root) };
}
beforeEach(() => localStorage.clear());
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
  vi.restoreAllMocks();
});

it("stays eligible until explicit dismissal, then remembers across instances but not accounts", () => {
  const { service } = fixture();
  const write = vi.spyOn(Storage.prototype, "setItem");
  expect(service.snapshot(viewer, id, facts)).toBe(true);
  expect(service.snapshot(viewer, id, { ...facts, channelType: "forum" })).toBe(
    true,
  );
  expect(write).not.toHaveBeenCalled();
  expect(service.dismiss(viewer, id)).toBe("saved");
  expect(service.snapshot(viewer, id, facts)).toBe(false);
  const reopened = fixture().service;
  expect(
    reopened.snapshot(viewer, id, { ...facts, channelType: "forum" }),
  ).toBe(false);
  expect(reopened.snapshot("b".repeat(64), id, facts)).toBe(true);
});

it.each([
  { channelType: undefined },
  { channelType: "dm" as const },
  { channelType: "session" as const },
  { surface: "other" as const },
  { isMe: true },
  { isMe: undefined },
])("keeps assistance ineligible outside its product rule: %o", (patch) => {
  expect(fixture().service.snapshot(viewer, id, { ...facts, ...patch })).toBe(
    false,
  );
});

it("notifies subscribers on local dismissal and another window's storage change", () => {
  const { service } = fixture();
  const changed = vi.fn();
  const stop = service.subscribe(changed);
  service.dismiss(viewer, id);
  expect(changed).toHaveBeenCalledTimes(1);
  // Emulate a browser-delivered deletion, not an actual cross-window journey.
  const key = localStorage.key(0);
  localStorage.removeItem(key ?? "missing");
  window.dispatchEvent(
    new StorageEvent("storage", { key, storageArea: localStorage }),
  );
  expect(changed).toHaveBeenCalledTimes(2);
  expect(service.snapshot(viewer, id, facts)).toBe(true);
  window.dispatchEvent(
    new StorageEvent("storage", { key: "other", storageArea: localStorage }),
  );
  window.dispatchEvent(
    new StorageEvent("storage", { key, storageArea: sessionStorage }),
  );
  expect(changed).toHaveBeenCalledTimes(2);
  stop();
  service.dismiss(viewer, id);
  expect(changed).toHaveBeenCalledTimes(2);
});

it("updates an eligible subscriber when another window creates a dismissal", () => {
  const { service } = fixture();
  const changed = vi.fn();
  expect(service.snapshot(viewer, id, facts)).toBe(true);
  service.subscribe(changed);
  const writer = fixture().service;
  expect(writer.dismiss(viewer, id)).toBe("saved");
  expect(changed).not.toHaveBeenCalled();
  const key = localStorage.key(0);
  if (!key) throw new Error("Missing dismissal marker");
  window.dispatchEvent(
    new StorageEvent("storage", {
      key,
      newValue: "dismissed",
      storageArea: localStorage,
    }),
  );
  expect(changed).toHaveBeenCalledOnce();
  expect(service.snapshot(viewer, id, facts)).toBe(false);
});

it("honors an unsaved dismissal for this run and reports that it wasn't remembered", () => {
  const { service } = fixture();
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Storage blocked");
    });
  expect(service.dismiss(viewer, id)).toBe("unsaved");
  expect(service.snapshot(viewer, id, facts)).toBe(false);
  expect(service.snapshot("b".repeat(64), id, facts)).toBe(true);
  expect(fixture().service.snapshot(viewer, id, facts)).toBe(true);
  window.dispatchEvent(
    new StorageEvent("storage", { key: null, storageArea: localStorage }),
  );
  expect(service.snapshot(viewer, id, facts)).toBe(false);
  write.mockRestore();
  expect(service.dismiss(viewer, id)).toBe("saved");
  expect(fixture().service.snapshot(viewer, id, facts)).toBe(false);
});

it("leaves assistance eligible on unreadable or malformed dismissal evidence", () => {
  const { service } = fixture();
  service.dismiss(viewer, id);
  const key = localStorage.key(0);
  if (!key) throw new Error("Missing dismissal");
  localStorage.setItem(key, "corrupt");
  const restored = fixture().service;
  expect(restored.snapshot(viewer, id, facts)).toBe(true);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  expect(restored.snapshot(viewer, id, facts)).toBe(true);
  expect(service.dismiss(viewer, id)).toBe("unsaved");
  expect(service.snapshot(viewer, id, facts)).toBe(false);
});

it("rejects missing or invalid accounts and fences retained handles after root disposal", async () => {
  const { root, service } = fixture();
  const changed = vi.fn();
  service.subscribe(changed);
  const write = vi.spyOn(Storage.prototype, "setItem");
  expect(service.snapshot(undefined, id, facts)).toBe(false);
  expect(service.snapshot("invalid", id, facts)).toBe(false);
  expect(service.dismiss("invalid", id)).toBe("unavailable");
  await root.fiber.dispose();
  expect(service.snapshot(viewer, id, facts)).toBe(false);
  expect(service.dismiss(viewer, id)).toBe("unavailable");
  window.dispatchEvent(
    new StorageEvent("storage", { key: null, storageArea: localStorage }),
  );
  expect(changed).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
