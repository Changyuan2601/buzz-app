// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agents } from "../../features/agents/service";
import type { RelaySession } from "../../features/relay/session";
import {
  saveWelcome,
  type WelcomeReceipt,
} from "../../features/sessions/welcome";
import { WelcomeActions } from "./WelcomeActions";

const key = "a".repeat(64);
const channel = "11111111-1111-4111-8111-111111111111";
const saved: WelcomeReceipt = {
  agent: key,
  channelId: channel,
  type: "test/agent",
  complete: true,
  greetingId: "b".repeat(64),
};
afterEach(() => {
  cleanup();
  localStorage.clear();
});
function fixture() {
  saveWelcome("test", saved);
  const send = vi.fn(async () => "c".repeat(64));
  const agents = { welcomeAction: send } as unknown as Agents;
  const ensure = vi.fn();
  const session = { channels: { ensure } } as unknown as RelaySession;
  const open = vi.fn(() => true);
  const onSend = vi.fn();
  const signal = new AbortController().signal;
  function Harness() {
    return (
      <WelcomeActions
        agents={agents}
        session={session}
        receipt={saved}
        scope="test"
        signal={signal}
        openProfile={open}
        onSend={onSend}
      />
    );
  }
  return { send, ensure, open, onSend, Harness };
}
it.each([
  ["Tell me about Buzz", "buzz"],
  ["Tell me about this community", "community"],
  ["Finish setting up this agent", "customize"],
] as const)(
  "sends %s only on explicit click, reveals the ordinary message, and never replays on remount",
  async (label, action) => {
    const f = fixture();
    const view = render(
      <StrictMode>
        <f.Harness />
      </StrictMode>,
    );
    expect(f.send).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(
      screen.getByRole("heading", { name: "Where would you like to start?" }),
    ).toBeVisible();
    expect(
      screen.getByText("Here are a few ideas, or just start chatting."),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(f.onSend).toHaveBeenCalledWith("c".repeat(64)));
    expect(f.send).toHaveBeenCalledExactlyOnceWith(
      key,
      channel,
      action,
      expect.any(AbortSignal),
    );
    expect(f.ensure).toHaveBeenCalledWith(channel);
    if (action === "customize")
      expect(f.open).toHaveBeenCalledWith(`buzz:agent-profile:${key}`);
    else expect(f.open).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByRole("status")).toBeNull();
    view.unmount();
    render(<f.Harness />);
    expect(f.send).toHaveBeenCalledOnce();
  },
);
it("blocks repeated clicks only while submitting, not while the agent replies", async () => {
  const f = fixture();
  let finish!: (id: string) => void;
  f.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<f.Harness />);
  try {
    await userEvent.click(
      screen.getByRole("button", { name: "Tell me about Buzz" }),
    );
    expect(f.send).toHaveBeenCalledOnce();
    for (const button of screen.getAllByRole("button"))
      expect(button).toBeDisabled();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => finish("c".repeat(64)));
    for (const button of screen.getAllByRole("button"))
      expect(button).toBeEnabled();
  } finally {
    finish("c".repeat(64));
  }
});
it("shows a send error without replay or a separate recovery button", async () => {
  const f = fixture();
  f.send.mockRejectedValueOnce(
    new Error("Join the conversation before posting"),
  );
  render(<f.Harness />);
  await userEvent.click(
    screen.getByRole("button", { name: "Tell me about Buzz" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Join the conversation before posting",
  );
  expect(f.onSend).not.toHaveBeenCalled();
  expect(screen.getAllByRole("button")).toHaveLength(3);
  await userEvent.click(
    screen.getByRole("button", { name: "Tell me about Buzz" }),
  );
  await waitFor(() => expect(f.onSend).toHaveBeenCalledOnce());
});
it("reports unavailable Profiles without sending the setup request", async () => {
  const f = fixture();
  f.open.mockReturnValue(false);
  render(<f.Harness />);
  await userEvent.click(
    screen.getByRole("button", { name: "Finish setting up this agent" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Agent details are unavailable",
  );
  expect(f.send).not.toHaveBeenCalled();
});
