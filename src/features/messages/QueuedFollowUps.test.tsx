// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { followUpQueue } from "./follow-up-queue";
import { QueuedFollowUps } from "./QueuedFollowUps";

afterEach(cleanup);
function fixture() {
  const session = {
    channels: { list: () => ({ channels: [{ id: "chat" }] }) },
    agentActivity: {
      activate: () => () => {},
      subscribe: () => () => {},
      snapshot: () => ({
        status: "listening",
        turns: [],
        local: [
          {
            agent: "agent",
            messageId: "old",
            channelId: "chat",
            state: "working",
          },
        ],
      }),
    },
  } as unknown as RelaySession;
  const queue = followUpQueue(session);
  const add = (text: string, beforeRelease?: () => Promise<void>) => {
    const publish = vi.fn(() => text);
    queue.submit({
      text,
      channelId: "chat",
      recipients: ["agent"],
      publish,
      ...(beforeRelease ? { beforeRelease } : {}),
    });
    return publish;
  };
  function mount() {
    render(
      <>
        <input aria-label="Composer" />
        <button type="button">Elsewhere</button>
        <QueuedFollowUps
          session={session}
          channelId="chat"
          disabled={false}
          focusComposer={() => screen.getByRole("textbox").focus()}
        />
      </>,
    );
  }
  return { queue, add, mount };
}
it("restores focus to a remaining row and then the composer after keyboard removal", async () => {
  const h = fixture();
  h.add("first");
  h.add("second");
  h.mount();
  const user = userEvent.setup();
  screen.getAllByRole("button", { name: "Remove queued message" })[0]?.focus();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Remove queued message" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("textbox")).toHaveFocus();
});
it("keeps focus on failed Send and restores it after successful retry", async () => {
  const h = fixture();
  const publish = h.add("first");
  publish.mockImplementationOnce(() => {
    throw new Error("Unavailable");
  });
  h.mount();
  const user = userEvent.setup();
  const send = screen.getByRole("button", { name: "Send" });
  send.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
  expect(send).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("textbox")).toHaveFocus();
});
it("does not steal focus moved outside a row during validation", async () => {
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const h = fixture();
  h.add("first", () => gate);
  h.mount();
  const user = userEvent.setup();
  const send = within(screen.getByRole("region")).getByRole("button", {
    name: "Send",
  });
  send.focus();
  await user.keyboard("{Enter}");
  screen.getByRole("button", { name: "Elsewhere" }).focus();
  await act(async () => {
    resume();
    await gate;
  });
  expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
});

it("preserves Send focus so consecutive Enter presses send both queued messages", async () => {
  const h = fixture();
  const first = h.add("first");
  const second = h.add("second");
  h.mount();
  const user = userEvent.setup();
  screen.getAllByRole("button", { name: "Send" })[0]?.focus();
  await user.keyboard("{Enter}");
  expect(first).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Send" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(second).toHaveBeenCalledOnce();
  expect(screen.getByRole("textbox")).toHaveFocus();
});
