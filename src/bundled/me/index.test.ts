// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { apply } from "./index";
import { meTarget } from "./routes";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
const scope = `https://relay.test:${"c".repeat(64)}`;
function host(snapshot: { scope?: string }) {
  const shortcuts = { register: vi.fn() };
  const navigation = { open: vi.fn(async () => ({ status: "opened" })) };
  const ctx = {
    pages: { register: vi.fn() },
    relay: { snapshot: () => snapshot },
    navigation,
    shortcuts,
  };
  apply(ctx as unknown as Parameters<typeof apply>[0]);
  const [shortcut] = shortcuts.register.mock.calls[0] ?? [];
  return { shortcut, open: navigation.open };
}
it("starts a new Me conversation with Mod+N", () => {
  const { shortcut, open } = host({ scope });
  expect(shortcut).toMatchObject({
    binding: { key: "n", mod: true },
    allowInEditable: true,
  });
  expect(shortcut.when()).toBe(true);
  shortcut.run();
  expect(open).toHaveBeenCalledExactlyOnceWith(meTarget(scope));
});
it("leaves Mod+N alone without a community", () => {
  const { shortcut, open } = host({});
  expect(shortcut.when()).toBe(false);
  shortcut.run();
  expect(open).not.toHaveBeenCalled();
});
it.each([
  ["Win32", false],
  ["MacIntel", true],
])("in a terminal on %s, Mod+N is eligible=%s", (platform, eligible) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const terminal = document.createElement("div");
  terminal.className = "xterm";
  const input = document.createElement("textarea");
  terminal.append(input);
  document.body.append(terminal);
  input.focus();
  expect(host({ scope }).shortcut.when()).toBe(eligible);
});
