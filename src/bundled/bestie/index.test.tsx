// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { Navigation } from "../../features/navigation/controller";
import { BestiePage } from "./index";
import { bestieFixture, cleanups, HOME } from "./testing";

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
composerDOMFixture();
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
HTMLElement.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  let next = 0;
  const randomUUID = crypto.randomUUID.bind(crypto);
  vi.spyOn(crypto, "randomUUID").mockImplementation(() =>
    next++ === 0 ? HOME : randomUUID(),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  cleanup();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  localStorage.clear();
  native.invoke.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(navigator, "platform");
});

it("keeps Bestie's page with a route to plugin settings while Builderlab is off", async () => {
  const open = vi.fn(async () => ({ status: "opened" }));
  render(
    <BestiePage
      navigation={{ open } as unknown as Navigation}
      extensions={{} as ConversationExtensions}
      host={{} as ConversationHostServices}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Turn on the Builderlab plugin",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Plugin settings" }),
  );
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "plugins",
  });
});

it("sets up Bestie and keeps the private conversation on its page", async () => {
  const h = await bestieFixture(native.invoke);
  const Page = h.pages.snapshot()[0]?.component;
  if (!Page) throw new Error("Missing Bestie page");
  render(<Page />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Set up Bestie" }),
  );
  expect(
    await screen.findByRole("region", { name: "Bestie conversation" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("textbox", { name: "Message #Bestie" }),
  ).toBeInTheDocument();
  expect(h.open).not.toHaveBeenCalled();
  expect(h.requests("register-agent")).toHaveLength(1);
});
