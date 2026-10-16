// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { apply } from "./index";

afterEach(() => vi.restoreAllMocks());
it.each([
  ["MacIntel", { key: "a", mod: true, ctrl: true }],
  ["Win32", { key: "e", mod: true, shift: true }],
])("on %s, Archive waits for an open conversation", (platform, binding) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const shortcuts = { register: vi.fn() };
  apply({
    pages: { register: vi.fn() },
    relay: {},
    navigation: {},
    shortcuts,
  } as unknown as Parameters<typeof apply>[0]);
  const [shortcut] = shortcuts.register.mock.calls[0] ?? [];
  expect(shortcut).toMatchObject({
    id: "archive-conversation",
    binding,
    allowInEditable: true,
  });
  expect(shortcut.when()).toBe(false);
  expect(() => shortcut.run()).not.toThrow();
});
