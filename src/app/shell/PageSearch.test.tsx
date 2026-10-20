// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageSearch, type SearchServices } from "./PageSearch";
import type { RegisteredPage } from "../../features/pages/service";
import {
  createShortcutBindings,
  SHORTCUT_BINDINGS_KEY,
} from "../../features/shortcuts/preferences";
import { ShortcutsService } from "../../features/shortcuts/service";
import { isApplePlatform } from "../../features/shortcuts/format";

// jsdom lacks scrollIntoView; the palette reveals its typed-text selection.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("keeps typing focus while arrows select results and Enter opens the selection", async () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  const select = vi.fn();
  const user = userEvent.setup();
  render(
    <PageSearch
      pages={[
        {
          key: "buzz.channels/channels",
          pluginId: "buzz.channels",
          id: "channels",
          title: "Channels",
          revision: "bundled",
          component: () => null,
        },
      ]}
      onSelect={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Search Buzz" }));
  const dialog = await screen.findByRole("dialog", { name: "Search Buzz" });
  const input = within(dialog).getByRole("combobox", { name: "Search Buzz" });
  const messages = within(dialog).getByRole("option", { name: "Messages" });
  expect(
    within(dialog).queryByRole("option", { name: "Home" }),
  ).not.toBeInTheDocument();
  const settings = within(dialog).getByRole("option", { name: "Settings" });
  for (const [attribute, value] of Object.entries({
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
    autocomplete: "off",
  }))
    expect(input).toHaveAttribute(attribute, value);
  await vi.waitFor(() => expect(input).toHaveFocus());
  for (const [key, result] of [
    ["ArrowDown", messages],
    ["ArrowDown", settings],
    ["ArrowDown", settings],
    ["ArrowUp", messages],
    ["ArrowUp", messages],
  ] as const) {
    await user.keyboard(`{${key}}`);
    expect(input).toHaveFocus();
    expect(result).toHaveAttribute("aria-selected", "true");
    expect(result).toHaveAttribute("data-highlighted");
    expect(result).not.toHaveAttribute("data-selected");
    expect(input).toHaveAttribute("aria-activedescendant", result.id);
  }
  fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "ArrowDown", keyCode: 229 });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  for (const modifier of ["metaKey", "ctrlKey", "altKey"]) {
    fireEvent.keyDown(input, { key: "ArrowDown", [modifier]: true });
    fireEvent.keyDown(input, { key: "Enter", [modifier]: true });
  }
  expect(messages).toHaveAttribute("aria-selected", "true");
  expect(messages).toHaveAttribute("data-highlighted", "true");
  expect(settings).toHaveAttribute("aria-selected", "false");
  expect(messages).not.toHaveAttribute("aria-current", "page");
  expect(select).not.toHaveBeenCalled();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith("settings");
  expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
});

it("clears selection on typing, handles empty results, and retains pointer activation", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const select = vi.fn();
  const user = userEvent.setup();
  render(<PageSearch pages={[]} onSelect={select} />);
  await user.click(screen.getByRole("button", { name: "Search Buzz" }));
  const input = await screen.findByRole("combobox", { name: "Search Buzz" });
  await user.click(input);
  await user.keyboard("{ArrowDown}");
  await user.type(input, "missing");
  expect(input).not.toHaveAttribute("aria-activedescendant");
  await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  expect(input).toHaveFocus();
  expect(select).not.toHaveBeenCalled();
  await user.clear(input);
  await user.type(input, "sett");
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("option", { name: "Settings" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("option", { name: "Settings" }));
  expect(select).toHaveBeenCalledExactlyOnceWith("settings");
});

it("closes search when the backdrop is clicked", async () => {
  const user = userEvent.setup();
  render(<PageSearch pages={[]} onSelect={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Search Buzz" }));
  expect(screen.getByRole("dialog", { name: "Search Buzz" })).toBeVisible();
  const backdrop = document.querySelector(".buzz-dialog-backdrop");
  expect(backdrop).not.toBeNull();
  await user.click(backdrop as Element);
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Search Buzz" })).toBeNull(),
  );
});

it("keeps result shortcuts without badges and follows the hovered row", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const select = vi.fn();
  const user = userEvent.setup();
  render(
    <PageSearch
      pages={[
        {
          key: "buzz.channels/channels",
          pluginId: "buzz.channels",
          id: "channels",
          title: "Channels",
          revision: "bundled",
          component: () => null,
        },
      ]}
      onSelect={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Search Buzz" }));
  const dialog = await screen.findByRole("dialog", { name: "Search Buzz" });
  const input = within(dialog).getByRole("combobox", { name: "Search Buzz" });
  const messages = within(dialog).getByRole("option", { name: "Messages" });
  const settings = within(dialog).getByRole("option", { name: "Settings" });
  const apple = isApplePlatform(navigator.platform);
  expect(messages).toHaveAttribute(
    "aria-keyshortcuts",
    `Shift+${apple ? "Meta" : "Control"}+1`,
  );
  expect(settings).toHaveAttribute(
    "aria-keyshortcuts",
    `Shift+${apple ? "Meta" : "Control"}+2`,
  );
  expect(dialog.querySelector("kbd")).toBeNull();
  await user.keyboard("{ArrowDown}");
  expect(messages).toHaveAttribute("aria-selected", "true");
  // A replayed event at a resting position is not a hover.
  const at = (clientX: number) =>
    fireEvent.pointerMove(settings, {
      pointerType: "mouse",
      clientX,
      clientY: 10,
      // Linux WebKit's screen coordinates do not follow the pointer.
      screenX: 0,
      screenY: 0,
    });
  at(10);
  at(10);
  expect(messages).toHaveAttribute("aria-selected", "true");
  at(12);
  expect(settings).toHaveAttribute("aria-selected", "true");
  expect(messages).toHaveAttribute("aria-selected", "false");
  expect(input).toHaveAttribute("aria-activedescendant", settings.id);
  fireEvent.keyDown(input, {
    key: "@",
    code: "Digit2",
    metaKey: apple,
    ctrlKey: !apple,
    shiftKey: true,
  });
  expect(select).toHaveBeenCalledExactlyOnceWith("settings");
});

it("selects the first typed result and keeps it as results change", async () => {
  const select = vi.fn();
  const user = userEvent.setup();
  const page = (key: string, title: string): RegisteredPage => ({
    key,
    pluginId: "test",
    id: key,
    title,
    revision: "bundled",
    component: () => null,
  });
  const first = page("test/first", "Target");
  const second = page("test/second", "Target ahead");
  const { rerender } = render(<PageSearch pages={[first]} onSelect={select} />);
  await user.click(screen.getByRole("button", { name: "Search Buzz" }));
  const input = await screen.findByRole("combobox", { name: "Search Buzz" });
  // An empty query selects nothing, so Enter alone opens nothing.
  expect(input).not.toHaveAttribute("aria-activedescendant");
  await user.type(input, "Target");
  const target = screen.getByRole("option", { name: /^Target$/ });
  expect(target).toHaveAttribute("aria-selected", "true");
  expect(input).toHaveAttribute("aria-activedescendant", target.id);
  // A later row above the selection cannot redirect Enter.
  rerender(<PageSearch pages={[second, first]} onSelect={select} />);
  expect(screen.getByRole("option", { name: /^Target$/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // When the selected row leaves, the new first result takes over and stays
  // selected when the old row returns.
  rerender(<PageSearch pages={[second]} onSelect={select} />);
  rerender(<PageSearch pages={[first, second]} onSelect={select} />);
  expect(input).toHaveFocus();
  expect(input).toHaveAttribute(
    "aria-activedescendant",
    screen.getByRole("option", { name: "Target ahead" }).id,
  );
  await user.keyboard("{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith("test/second");
});

it("shows the live search shortcut in the trigger hint and follows a rebind", async () => {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  try {
    // Only the shortcut services are read while the dialog is closed.
    render(
      <PageSearch
        pages={[]}
        onSelect={vi.fn()}
        services={
          { shortcuts, shortcutBindings: bindings } as unknown as SearchServices
        }
      />,
    );
    // The title renders as a focus/hover tooltip rather than a native attribute.
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("button", { name: "Search Buzz" })).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Search Buzz (⌘K)",
    );
    act(() =>
      bindings.set("global-search", { key: "p", mod: true, shift: true }),
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent("Search Buzz (⇧⌘P)");
    act(() => bindings.reset());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Search Buzz (⌘K)");
  } finally {
    Reflect.deleteProperty(navigator, "platform");
    bindings.dispose();
    await root.fiber.dispose();
  }
});

it("opens conversation-scoped search with Command F and returns to overall search", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  const connection = { status: "disconnected", generation: 0 };
  const navigation = {
    entry: { target: { kind: "conversation", channelId: "crew" } },
  };
  const community = { selected: null, viewer: null };
  const services = {
    shortcuts,
    shortcutBindings: bindings,
    navigation: {
      subscribe: () => () => {},
      snapshot: () => navigation,
    },
    communities: {
      subscribe: () => () => {},
      snapshot: () => community,
      relay: { subscribe: () => () => {}, snapshot: () => connection },
    },
  } as unknown as SearchServices;
  try {
    render(<PageSearch pages={[]} onSelect={vi.fn()} services={services} />);
    const apple = isApplePlatform(navigator.platform);
    fireEvent.keyDown(window, {
      key: "f",
      metaKey: apple,
      ctrlKey: !apple,
    });
    const scoped = await screen.findByRole("dialog", {
      name: "Search this conversation",
    });
    expect(
      within(scoped).getByRole("combobox", {
        name: "Search this conversation",
      }),
    ).toHaveFocus();
    expect(
      within(scoped).getByRole("button", {
        name: "Remove This conversation search scope",
      }),
    ).toBeVisible();
    fireEvent.click(
      within(scoped).getByRole("button", {
        name: "Remove This conversation search scope",
      }),
    );
    expect(screen.getByRole("dialog", { name: "Search Buzz" })).toBeVisible();
  } finally {
    cleanup();
    bindings.dispose();
    await root.fiber.dispose();
  }
});

it("ranks pages by match when no community is connected", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  const connection = { status: "disconnected", generation: 0 };
  const community = { selected: null, viewer: null };
  const services = {
    shortcuts,
    shortcutBindings: bindings,
    navigation: {
      subscribe: () => () => {},
      snapshot: () => ({ entry: { target: null } }),
    },
    communities: {
      subscribe: () => () => {},
      snapshot: () => community,
      relay: { subscribe: () => () => {}, snapshot: () => connection },
    },
  } as unknown as SearchServices;
  const page = (key: string, title: string): RegisteredPage => ({
    key,
    pluginId: "test",
    id: key,
    title,
    revision: "bundled",
    component: () => null,
  });
  const select = vi.fn();
  const user = userEvent.setup();
  try {
    render(
      <PageSearch
        pages={[
          page("test/processes", "Processes"),
          page("test/sessions", "Sessions"),
        ]}
        onSelect={select}
        services={services}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Search Buzz" }));
    const input = await screen.findByRole("combobox", { name: "Search Buzz" });
    // "ses" starts Sessions, appears inside Processes, and only fuzzily
    // matches Settings.
    await user.type(input, "ses");
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Sessions", "Processes", "Settings"]);
    await user.keyboard("{Enter}");
    expect(select).toHaveBeenCalledExactlyOnceWith("test/sessions");
  } finally {
    cleanup();
    bindings.dispose();
    await root.fiber.dispose();
  }
});

it("renders a restored prototype-named search key and remains resettable", async () => {
  localStorage.setItem(
    SHORTCUT_BINDINGS_KEY,
    JSON.stringify({ "global-search": { key: "constructor", mod: true } }),
  );
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(root, window, bindings);
  try {
    render(
      <PageSearch
        pages={[]}
        onSelect={vi.fn()}
        services={
          { shortcuts, shortcutBindings: bindings } as unknown as SearchServices
        }
      />,
    );
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("button", { name: "Search Buzz" })).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("constructor");
    act(() => bindings.reset());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Ctrl+K");
  } finally {
    bindings.dispose();
    localStorage.clear();
    await root.fiber.dispose();
  }
});

it.each(["pointer", "keyboard"])(
  "hands %s page selection to main, not its first control",
  async (method) => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const user = userEvent.setup();
    const select = vi.fn();
    render(
      <>
        <PageSearch pages={[]} onSelect={select} />
        <main id="main-content" tabIndex={-1}>
          <button type="button">First control</button>
        </main>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Search Buzz" });
    await user.click(trigger);
    if (method === "pointer")
      await user.click(screen.getByRole("option", { name: "Settings" }));
    else await user.keyboard("{ArrowDown}{Enter}");
    expect(select).toHaveBeenCalledExactlyOnceWith("settings");
    await vi.waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
    await user.click(trigger);
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(trigger).toHaveFocus());
  },
);

it("shows a plugin page's declared icon on its search row", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const user = userEvent.setup();
  const icon = "data:image/png;base64,iVBORbeacon";
  render(
    <PageSearch
      pages={[
        {
          key: "example.plugin/main",
          pluginId: "example.plugin",
          id: "main",
          title: "Beacon",
          revision: "one",
          component: () => null,
          icon,
        },
        {
          key: "example.other/main",
          pluginId: "example.other",
          id: "main",
          title: "Plain",
          revision: "one",
          component: () => null,
        },
      ]}
      onSelect={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Search Buzz" }));
  const dialog = await screen.findByRole("dialog", { name: "Search Buzz" });
  const beacon = within(dialog).getByRole("option", { name: "Beacon" });
  const plain = within(dialog).getByRole("option", { name: "Plain" });
  const image = beacon.querySelector("img");
  expect(image).toBeInstanceOf(HTMLImageElement);
  expect(image).toHaveAttribute("src", icon);
  expect(plain.querySelector("img")).toBeNull();
});
