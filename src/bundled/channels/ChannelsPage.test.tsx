// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { Panels } from "../../features/panels/service";
import { ChannelsPage, mediaReviewForDestination } from "./ChannelsPage";

afterEach(cleanup);
// Run the page's hooks in React, then inspect its returned workspace element.
// Browser journeys exercise the workspace subtree and navigation interactions.
// Inspect the actual element returned at the workspace boundary, not a parallel
// key helper. React uses this key to decide whether to retain the subtree.
vi.mock("../../features/relay/react", async (original) => ({
  ...(await original<typeof import("../../features/relay/react")>()),
  useRelayConnection: (relay: RelayData) => relay.snapshot(),
}));
function workspace(scope: string, generation: number) {
  const snapshot = { status: "ready", scope, generation } as RelaySnapshot;
  const relay = { snapshot: () => snapshot } as RelayData;
  const page = renderHook(() =>
    ChannelsPage({
      relay,
      panels: {} as Panels,
      navigator: createNavigationController(createMemoryHistory()).navigation,
    }),
  ).result.current;
  return page.props.children as ReactElement<{ scope: string }>;
}

it("never carries a media review across channel navigation or resurrects it on return", () => {
  const review = { channelId: "alpha", messageId: "root", entryId: "visit-a" };
  expect(mediaReviewForDestination(review, "alpha", "visit-a")).toBe(review);
  expect(mediaReviewForDestination(review, "beta", "visit-a")).toBeUndefined();
  expect(mediaReviewForDestination(review, "alpha", "visit-b")).toBeUndefined();
  expect(
    mediaReviewForDestination(undefined, "alpha", "visit-a"),
  ).toBeUndefined();
});

it("distinguishes ready communities with the same connection generation", () => {
  const a = workspace("community-a:viewer", 1);
  const b = workspace("community-b:viewer", 1);
  expect(a.key).not.toBe(b.key);
  expect(a.props.scope).toBe("community-a:viewer");
  expect(b.props.scope).toBe("community-b:viewer");
});
it("distinguishes a replacement session within one scope without changing persisted intent keys", () => {
  const before = workspace("community-a:viewer", 1);
  const after = workspace("community-a:viewer", 2);
  expect(before.key).not.toBe(after.key);
  expect(before.props.scope).toBe(after.props.scope);
});
it("keeps the same workspace identity for updates within a session", () => {
  expect(workspace("community-a:viewer", 1).key).toBe(
    workspace("community-a:viewer", 1).key,
  );
});

it("the actual workspace receives session-bound authority, never the page's reusable authority", async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { provideNavigation } = await import(
    "../../features/navigation/service"
  );
  const { provideRelay } = await import("../../features/relay/service");
  const ctx = new Context();
  const host = provideNavigation(ctx);
  const source = provideRelay(ctx);
  const relay: RelayData = {
    ...source,
    snapshot: () => ({ ...source.snapshot(), status: "ready" }),
  };
  try {
    const pending = host.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "buzz.channels",
      pageId: "channels",
    });
    const parent = host.request(host.navigation.snapshot().attempt, {
      valid: () => true,
      subscribe: () => () => {},
    }).request;
    const rendered = renderHook(() =>
      ChannelsPage({
        relay,
        panels: {} as Panels,
        navigation: parent,
        navigator: host.navigation,
      }),
    ).result.current;
    const workspace = rendered.props.children as ReactElement<{
      navigation: typeof parent;
    }>;
    source.disconnect();
    expect(workspace.props.navigation.signal.aborted).toBe(true);
    expect(workspace.props.navigation.complete({ status: "opened" })).toBe(
      false,
    );
    expect(
      workspace.props.navigation.resolve({ version: 1, kind: "settings" }),
    ).toBe(false);
    expect(parent.signal.aborted).toBe(false);
    const replacement = renderHook(() =>
      ChannelsPage({
        relay,
        panels: {} as Panels,
        navigation: parent,
        navigator: host.navigation,
      }),
    ).result.current.props.children as typeof workspace;
    expect(replacement.props.navigation.complete({ status: "opened" })).toBe(
      true,
    );
    expect(await pending).toEqual({ status: "opened" });
  } finally {
    await ctx.fiber.dispose();
  }
});
