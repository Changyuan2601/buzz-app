// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { composerDOMFixture } from "../../features/messages/composer-testing";
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
  render(<BestiePage navigation={{ open } as unknown as Navigation} />);
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
  expect(
    screen.queryByRole("button", { name: "Set up Bestie workflows" }),
  ).not.toBeInTheDocument();
  expect(h.open).not.toHaveBeenCalled();
  expect(h.requests("register-agent")).toHaveLength(1);
});

it("keeps the finished conversation on the page when saving workflows fails, then retries only them", async () => {
  const h = await bestieFixture(native.invoke);
  const query = h.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  h.query.mockImplementation(async (filters) => {
    if (filters.some((filter) => filter.kinds?.includes(30620)))
      throw new Error("unavailable");
    return query(filters);
  });
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
    screen.getByRole("button", { name: "Set up Bestie workflows" }),
  ).toBeInTheDocument();
  h.query.mockImplementation(query);
  await userEvent.click(
    screen.getByRole("button", { name: "Set up Bestie workflows" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Set up Bestie workflows" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("region", { name: "Bestie conversation" }),
  ).toBeInTheDocument();
  expect(h.open).not.toHaveBeenCalled();
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.events.filter((event) => event.kind === 9)).toHaveLength(1);
  expect(h.events.filter((event) => event.kind === 30620)).toHaveLength(3);
});
