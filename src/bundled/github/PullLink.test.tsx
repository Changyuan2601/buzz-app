// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { Contribution } from "../../plugins/contributions";
import type { LinkRenderer } from "../../features/conversation/contracts";
import {
  LinkInteractiveContext,
  LinkLabelContext,
} from "../../features/conversation/LinkLabelContext";
import {
  MessageLink,
  resolveLink,
} from "../../features/conversation/MessageLink";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import inlineStyles from "../../shared/InlineReference.module.css";
import { apply as applyLinks } from "../links/index";
import { apply } from "./index";
import { PullLink } from "./PullLink";
import { stateIcons } from "./pull-state-view";
import type { PullState, PullStates } from "./pull-states";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pull = "https://github.com/block/buzz-app/pull/7";

/** A store the test moves by hand. */
function fakeStates(initial?: PullState | "failed") {
  let value = initial;
  const listeners = new Set<() => void>();
  const unwatch = vi.fn();
  return {
    watch: vi.fn((_url: string, listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unwatch();
      };
    }),
    get: () => value,
    unwatch,
    set(next: PullState | "failed" | undefined) {
      value = next;
      for (const listener of listeners) listener();
    },
  } satisfies PullStates & Record<string, unknown>;
}
const glyph = (Icon: (typeof stateIcons)[keyof typeof stateIcons]) =>
  renderToStaticMarkup(
    <Icon aria-hidden="true" className={inlineStyles.icon} />,
  );
const icon = (container: HTMLElement) =>
  container.querySelector("[data-pr-state]");

it("shows the authored label with the plain pull request glyph until read, then each state's own", () => {
  const states = fakeStates();
  const { container } = render(
    <LinkLabelContext value="fix(search): tokens">
      <PullLink url={pull} states={states} />
    </LinkLabelContext>,
  );
  expect(container).toHaveTextContent("fix(search): tokens");
  expect(icon(container)).toHaveAttribute("data-pr-state", "unknown");
  expect(icon(container)).toHaveAttribute("title", "Pull request");
  // The state is read out, not only shown.
  expect(screen.getByRole("img", { name: "Pull request" })).toBe(
    icon(container),
  );
  expect(icon(container)?.innerHTML).toBe(glyph(stateIcons.open));
  for (const [state, words] of [
    [
      { state: "open", checks: "pending" },
      "Pull request, open, checks running",
    ],
    [{ state: "draft", conflicts: true }, "Pull request, draft, conflicts"],
    [{ state: "merged" }, "Pull request, merged"],
    [{ state: "closed" }, "Pull request, closed"],
  ] as const) {
    act(() => states.set(state));
    expect(icon(container)).toHaveAttribute("data-pr-state", state.state);
    expect(icon(container)).toHaveAttribute("title", words);
    expect(screen.getByRole("img", { name: words })).toBe(icon(container));
    expect(icon(container)?.innerHTML).toBe(glyph(stateIcons[state.state]));
  }
  // One GitHub cannot read keeps the plain glyph, and says so.
  act(() => states.set("failed"));
  expect(icon(container)).toHaveAttribute("data-pr-state", "unknown");
  expect(icon(container)).toHaveAttribute("title", "Pull request, unavailable");
  expect(screen.getByRole("img", { name: "Pull request, unavailable" })).toBe(
    icon(container),
  );
  expect(icon(container)?.innerHTML).toBe(glyph(stateIcons.open));
});

it("shows what is known of a pull request while composing, without watching it", () => {
  const states = fakeStates({ state: "merged" });
  const { container } = render(
    <LinkInteractiveContext value={false}>
      <PullLink url={pull} states={states} />
    </LinkInteractiveContext>,
  );
  expect(icon(container)).toHaveAttribute("data-pr-state", "merged");
  expect(states.watch).not.toHaveBeenCalled();
});

it("watches the pull request only while shown", () => {
  const states = fakeStates({ state: "open" });
  const { unmount } = render(<PullLink url={pull} states={states} />);
  expect(states.watch).toHaveBeenCalledWith(pull, expect.any(Function));
  expect(states.watch).toHaveBeenCalledOnce();
  unmount();
  expect(states.unwatch).toHaveBeenCalledOnce();
});

/** Both bundled renderers, registered as the host would hold them. */
function renderers() {
  const found: Contribution<LinkRenderer>[] = [];
  const register = (pluginId: string) => (renderer: LinkRenderer) => {
    found.push({
      ...renderer,
      key: `${pluginId}/${renderer.id}`,
      pluginId,
      revision: "one",
    });
  };
  applyLinks({
    conversation: { registerLink: register("buzz.links") },
  } as never);
  apply({
    host: {},
    panels: { register: () => {} },
    conversation: {
      registerChatIcon: () => {},
      registerChatMenu: () => {},
      registerLink: register("buzz.github"),
    },
    relay: {},
    agents: { addTool: () => {} },
    inject: () => {},
  } as never);
  const [links, github] = found;
  if (!links || !github) throw new Error("expected both renderers");
  return { links, github };
}
const registry = (entries: readonly Contribution<LinkRenderer>[]) => ({
  snapshot: () => entries,
  subscribe: () => () => {},
});
const message = (
  entries: readonly Contribution<LinkRenderer>[],
  interactive = true,
) =>
  render(
    <ToastProvider>
      <MessageLink
        url={pull}
        registry={registry(entries)}
        onOpenLink={() => true}
        label="Fix the lab"
        interactive={interactive}
      />
    </ToastProvider>,
  );

it("takes pull request links from Links, which keeps the rest of GitHub and stands in without it", async () => {
  const { links, github } = renderers();
  expect(resolveLink(pull, [links, github])).toBe(github);
  expect(
    resolveLink("https://github.com/block/buzz-app", [github, links]),
  ).toBe(links);
  expect(
    resolveLink("https://github.com/block/buzz-app/issues/7", [github, links]),
  ).toBe(links);
  expect(resolveLink(`${pull}#issuecomment-1`, [github, links])).toBe(links);

  // Without gh in this host, the state comes from the public API.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ state: "open" }))),
  );
  const both = message([links, github]);
  const anchor = screen.getByRole("link", { name: "Fix the lab" });
  expect(anchor).toHaveAttribute("href", pull);
  expect(anchor).toHaveAttribute("data-link-renderer", "buzz.github/pull");
  expect(anchor.className).toBe(inlineStyles.link);
  expect(icon(both.container)).toHaveAttribute("data-pr-state", "unknown");
  await waitFor(() =>
    expect(icon(both.container)).toHaveAttribute("data-pr-state", "open"),
  );
  // The state joins the accessibility tree; the link keeps its authored name.
  expect(within(anchor).getByRole("img", { name: "Pull request, open" })).toBe(
    icon(both.container),
  );
  expect(screen.getByRole("link", { name: "Fix the lab" })).toBe(anchor);
  cleanup();

  const only = message([links]);
  expect(screen.getByRole("link")).toHaveAttribute(
    "data-link-renderer",
    "buzz.links/links",
  );
  expect(icon(only.container)).toBeNull();
  expect(only.container.querySelector("[data-link-kind]")).toHaveAttribute(
    "data-link-kind",
    "github",
  );
});

it("reads nothing for a pull request link while it is composed", async () => {
  const { links, github } = renderers();
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ state: "open" })),
  );
  vi.stubGlobal("fetch", fetch);
  // Typing the link mounts a decoration for `/pull/1`, `/pull/17`, …; none of
  // them spends a public read.
  const { container } = message([links, github], false);
  // The store reads in a microtask after the first subscriber; flush it.
  await act(async () => {});
  expect(screen.queryByRole("link")).toBeNull();
  expect(container).toHaveTextContent("Fix the lab");
  expect(icon(container)).toHaveAttribute("data-pr-state", "unknown");
  expect(fetch).not.toHaveBeenCalled();
});

it("leaves the plain link when the renderer fails", () => {
  const { links, github } = renderers();
  const broken = {
    ...github,
    component: () => {
      throw new Error("broken renderer");
    },
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { container } = message([links, broken]);
    const anchor = screen.getByRole("link", { name: "Fix the lab" });
    expect(anchor).toHaveAttribute("href", pull);
    expect(anchor).not.toHaveAttribute("data-link-renderer");
    expect(container.querySelector("[data-link-kind]")).toBeNull();
  } finally {
    error.mockRestore();
  }
});
