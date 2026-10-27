// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import { apply } from "./index";
import type { SoloPull, SoloPulls } from "./solo-pull";
import { SoloPullIcon, SoloPullLink } from "./SoloPull";

afterEach(cleanup);

const chat = "11111111-1111-4111-8111-111111111111";
const team = "22222222-2222-4222-8222-222222222222";
const viewer = "c".repeat(64);
const pull = "https://github.com/block/buzz-app/pull/7";

function fakePulls(initial: Record<string, SoloPull> = {}) {
  const links = new Map(Object.entries(initial));
  const listeners = new Set<() => void>();
  return {
    watch: vi.fn((_channel: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    get: (channel: string) => links.get(channel),
    linked: vi.fn((channel: string, url: string | null) => {
      if (url) links.set(channel, { url });
      else links.delete(channel);
      for (const listener of listeners) listener();
    }),
  } satisfies SoloPulls;
}

it("stands in for the chat icon with the pull request's state, in words too", () => {
  const pulls = fakePulls({
    [chat]: {
      url: pull,
      state: { state: "open", checks: "failure", conflicts: true },
    },
  });
  const { container, rerender } = render(
    <SoloPullIcon pulls={pulls} channelId={chat} fallback="bubble" />,
  );
  expect(
    screen.getByText("Pull request, open, checks failing, conflicts:"),
  ).toBeInTheDocument();
  expect(container.querySelector("[data-tone]")).toHaveAttribute(
    "data-tone",
    "failure",
  );
  for (const [state, words, tone] of [
    [{ state: "merged" }, "Pull request, merged:", "merged"],
    [
      { state: "draft", checks: "pending" },
      "Pull request, draft, checks running:",
      "draft",
    ],
    [{ state: "open", checks: "success" }, "Pull request, open:", "open"],
  ] as const) {
    rerender(
      <SoloPullIcon
        pulls={fakePulls({ [chat]: { url: pull, state } })}
        channelId={chat}
        fallback="bubble"
      />,
    );
    expect(screen.getByText(words)).toBeInTheDocument();
    expect(container.querySelector("[data-tone]")).toHaveAttribute(
      "data-tone",
      tone,
    );
  }
  rerender(<SoloPullIcon pulls={pulls} channelId={team} fallback="bubble" />);
  expect(container).toHaveTextContent(/^bubble$/);
});

function relayWith(channels: { id: string; channelType: string }[]) {
  const sign = vi.fn(async (template: object) => ({
    ...template,
    id: "f".repeat(64),
    pubkey: viewer,
    sig: "",
  }));
  const publish = vi.fn(async () => "");
  const list = {
    status: "ready" as const,
    channels: channels.map((channel) => ({
      ...channel,
      name: channel.id,
      creator: viewer,
    })),
  };
  const session = {
    viewer,
    snapshotRead: vi.fn(async () => []),
    configArtifactWriter: { sign, publish },
    channels: {
      ensureList: () => () => {},
      subscribeList: () => () => {},
      list: () => list,
    },
  } as unknown as RelaySession;
  const snapshot = { status: "ready", generation: 1, scope: "s", session };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  return { relay, session, sign, publish };
}

it("links the pull request to the Solo chat it was opened from, and unlinks it", async () => {
  const { relay, sign, publish } = relayWith([
    { id: chat, channelType: "solo" },
    { id: team, channelType: "stream" },
  ]);
  const pulls = fakePulls();
  const { rerender } = render(
    <SoloPullLink
      relay={relay}
      pullsFor={() => pulls}
      channelId={chat}
      url={pull}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Link to this chat" }),
  );
  expect(await screen.findByRole("button", { name: "Unlink" })).toBeEnabled();
  expect(pulls.linked).toHaveBeenCalledWith(chat, pull);
  expect(sign).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledOnce();
  expect(
    screen.getByText("Shown in the sidebar for this chat."),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Unlink" }));
  expect(
    await screen.findByRole("button", { name: "Link to this chat" }),
  ).toBeInTheDocument();
  expect(pulls.linked).toHaveBeenLastCalledWith(chat, null);

  // A team channel is not a Solo chat; nothing to link.
  rerender(
    <SoloPullLink
      relay={relay}
      pullsFor={() => pulls}
      channelId={team}
      url={pull}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
});

it("gives agents a link_pr tool for the Solo chat they work in", async () => {
  const { relay, sign } = relayWith([
    { id: chat, channelType: "solo" },
    { id: team, channelType: "stream" },
  ]);
  let tool: AddedTool | undefined;
  apply({
    host: {},
    panels: { register: () => {} },
    conversation: { registerChatIcon: () => {}, registerLink: () => {} },
    relay,
    agents: {
      addTool: (added: AddedTool) => {
        tool = added;
      },
      relay: () => relay,
    },
    inject: () => {},
  } as never);
  const client = {
    key: "a".repeat(64),
    pubkey: "a".repeat(64),
  } as BuzzClient;
  expect(tool?.name).toBe("link_pr");
  await expect(
    tool?.call(client, { channel: chat }, { url: "https://github.com/block" }),
  ).rejects.toThrow("url must be a GitHub pull request URL");
  await expect(
    tool?.call(client, { channel: team }, { url: pull }),
  ).rejects.toThrow("Only a Solo chat can be linked");
  expect(await tool?.call(client, { channel: chat }, { url: pull })).toBe(
    `Linked ${pull}. The sidebar shows its state for this chat.`,
  );
  expect(sign).toHaveBeenCalledOnce();
  expect(await tool?.call(client, { channel: chat }, { unlink: true })).toBe(
    "Unlinked this chat's pull request.",
  );
});
