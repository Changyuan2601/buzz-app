// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Profiler, useLayoutEffect } from "react";
import type { ComposerAccessoryProps, ComposerAccessory } from "./contracts";
import type { Contribution } from "../../plugins/contributions";
import { ComposerAccessories } from "./ComposerAccessories";
import type { RelaySession } from "../relay/session";

afterEach(cleanup);

it("revokes navigation after contribution removal, replacement and composer unmount", () => {
  let commands!: ComposerAccessoryProps;
  function Accessory(props: ComposerAccessoryProps) {
    useLayoutEffect(() => {
      commands = props;
    });
    return null;
  }
  const entry: Contribution<ComposerAccessory> = {
    id: "activity",
    key: "test:activity",
    pluginId: "test",
    revision: "one",
    title: "Activity",
    component: Accessory,
  };
  let entries = [entry];
  const listeners = new Set<() => void>();
  const registry = {
    snapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const publish = () =>
    act(() => {
      for (const listener of listeners) listener();
    });
  const open = vi.fn(() => true);
  const canOpen = vi.fn(() => true);
  const view = render(
    <ComposerAccessories
      registry={registry}
      session={{} as RelaySession}
      scope="scope"
      channelId="channel"
      open={open}
      canOpen={canOpen}
    />,
    { reactStrictMode: true },
  );
  const original = commands;
  expect(original.open("target")).toBe(true);
  expect(original.canOpen("target")).toBe(true);
  entries = [];
  // Registry invalidation must reject saved commands even before React commits.
  expect(original.open("target")).toBe(false);
  expect(original.canOpen("target")).toBe(false);
  publish();
  entries = [entry];
  publish();
  const restored = commands;
  expect(original.open("target")).toBe(false);
  expect(restored.open("target")).toBe(true);
  entries = [{ ...entry, revision: "two" }];
  expect(restored.open("target")).toBe(false);
  expect(restored.canOpen("target")).toBe(false);
  publish();
  const replacement = commands;
  expect(replacement.open("target")).toBe(true);
  view.unmount();
  expect(replacement.open("target")).toBe(false);
  expect(replacement.canOpen("target")).toBe(false);
  expect(listeners.size).toBe(0);
  expect(open).toHaveBeenCalledTimes(3);
  expect(canOpen).toHaveBeenCalledTimes(1);
});

it("keeps message accessories out of the composer and revokes commands on message changes", () => {
  const commands: ComposerAccessoryProps[] = [];
  const entry: Contribution<ComposerAccessory> = {
    id: "activity",
    key: "test:message",
    pluginId: "test",
    revision: "one",
    title: "Activity",
    placement: "message",
    component: function MessageAccessory(props) {
      useLayoutEffect(() => {
        commands.push(props);
      });
      return <span>Message activity</span>;
    },
  };
  const entries = [entry];
  const registry = { snapshot: () => entries, subscribe: () => () => {} };
  const props = {
    registry,
    session: {} as RelaySession,
    scope: "scope",
    channelId: "channel",
    canOpen: () => true,
    open: vi.fn(() => true),
    openThread: vi.fn(() => true),
    onFocusedRemoval: vi.fn(),
  };
  const message = {
    id: "one",
    channelId: "channel",
    authorId: "human",
    content: "request",
    createdAt: 1,
    mentions: [],
    attachments: [],
    reactions: [],
    participants: [],
    replyCount: 0,
  };
  const view = render(<ComposerAccessories {...props} />);
  expect(screen.queryByText("Message activity")).toBeNull();
  view.rerender(<ComposerAccessories {...props} message={message} />);
  expect(screen.getByText("Message activity")).toBeTruthy();
  const original = commands.at(-1);
  if (!original) throw new Error("Missing accessory commands");
  expect(original.message?.id).toBe("one");
  expect(original.openThread?.()).toBe(true);
  original.onFocusedRemoval?.();
  expect(props.onFocusedRemoval).toHaveBeenCalledOnce();
  expect(original.open("target")).toBe(true);
  view.rerender(
    <ComposerAccessories {...props} message={{ ...message, id: "two" }} />,
  );
  expect(original.open("target")).toBe(false);
  expect(original.openThread?.()).toBe(false);
  original.onFocusedRemoval?.();
  expect(props.onFocusedRemoval).toHaveBeenCalledOnce();
  expect(commands.at(-1)?.openThread?.()).toBe(true);
  expect(commands.at(-1)?.message?.id).toBe("two");
  expect(commands.at(-1)?.open("target")).toBe(true);
  view.unmount();
  expect(commands.at(-1)?.open("target")).toBe(false);
  expect(commands.at(-1)?.openThread?.()).toBe(false);
  commands.at(-1)?.onFocusedRemoval?.();
  expect(props.onFocusedRemoval).toHaveBeenCalledOnce();
  expect(props.openThread).toHaveBeenCalledTimes(2);
});

it("gives only one decorator the host summary and restores the fallback on removal", () => {
  const renderMessageSummary = vi.fn(() => (
    <button type="button">6 replies</button>
  ));
  function Decorator(props: ComposerAccessoryProps) {
    return (
      <>
        {props.renderMessageSummary?.()}
        <span>Activity preview</span>
      </>
    );
  }
  const first: Contribution<ComposerAccessory> = {
    id: "summary",
    key: "test:summary",
    pluginId: "test",
    revision: "one",
    title: "Summary",
    placement: "message",
    decoratesMessageSummary: true,
    component: Decorator,
  };
  let entries = [first, { ...first, key: "test:summary-two" }];
  const registry = { snapshot: () => entries, subscribe: () => () => {} };
  const props = {
    registry,
    session: {} as RelaySession,
    scope: "scope",
    channelId: "channel",
    message: { id: "message" } as NonNullable<
      ComposerAccessoryProps["message"]
    >,
    open: () => false,
    canOpen: () => false,
    renderMessageSummary,
  };
  const view = render(<ComposerAccessories {...props} />);
  expect(screen.getAllByRole("button", { name: "6 replies" })).toHaveLength(1);
  entries = [];
  view.rerender(<ComposerAccessories {...props} />);
  expect(screen.getAllByRole("button", { name: "6 replies" })).toHaveLength(1);
  expect(screen.queryByText("Activity preview")).toBeNull();
});

it("mounts an accessory in its host's first render with commands it can use", () => {
  const rendered: boolean[] = [];
  const committed: boolean[] = [];
  let renders = 0;
  let commits = 0;
  let commands!: ComposerAccessoryProps;
  function Accessory(props: ComposerAccessoryProps) {
    renders += 1;
    rendered.push(props.canOpen("target"));
    useLayoutEffect(() => {
      commands = props;
      committed.push(props.open("target"));
    });
    return <span>Accessory</span>;
  }
  const entry: Contribution<ComposerAccessory> = {
    id: "activity",
    key: "test:first",
    pluginId: "test",
    revision: "one",
    title: "Activity",
    component: Accessory,
  };
  const entries = [entry];
  const registry = { snapshot: () => entries, subscribe: () => () => {} };
  const open = vi.fn(() => true);
  const view = render(
    <Profiler id="accessories" onRender={() => commits++}>
      <ComposerAccessories
        registry={registry}
        session={{} as RelaySession}
        scope="scope"
        channelId="channel"
        open={open}
        canOpen={() => true}
      />
    </Profiler>,
  );
  expect(screen.getByText("Accessory")).toBeTruthy();
  // No second, cascaded commit to swap a fallback for the accessory.
  expect(commits).toBe(1);
  expect(renders).toBe(1);
  expect(rendered).toEqual([true]);
  expect(committed).toEqual([true]);
  view.unmount();
  expect(commands.canOpen("target")).toBe(false);
  expect(commands.open("target")).toBe(false);
  expect(open).toHaveBeenCalledOnce();
});
