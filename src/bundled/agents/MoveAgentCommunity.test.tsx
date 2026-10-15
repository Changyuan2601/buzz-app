// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { communityRequest } from "../../features/communities/api";
import { controlFixture } from "../../features/agents/control-testing";
import { createAgentControl } from "../../features/agents/control";
import { MoveAgentCommunity } from "./MoveAgentCommunity";

vi.mock("../../features/communities/api", () => ({
  communityRequest: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("verifies the owner before moving the exact stopped setup and revision", async () => {
  const f = controlFixture();
  Object.assign(f.agent, {
    enabled: false,
    status: "stopped",
    runningRevision: null,
  });
  const move = vi.fn(async () => ({
    agents: [f.agent],
    runtimeAvailable: true,
  }));
  f.host.moveCommunity = move;
  const control = createAgentControl(f.host);
  await control.refresh();
  const owner = "cd".repeat(32);
  const resolution = {
    pubkey: f.agent.pubkey,
    owner,
    relayUrl: "wss://other.example",
    signature: "signed",
  };
  vi.mocked(communityRequest).mockResolvedValue(resolution);
  const moved = vi.fn();
  render(
    <MoveAgentCommunity
      agent={f.agent}
      control={control}
      owner={owner}
      disabled={false}
      onMoved={moved}
    />,
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Destination community" }),
    { target: { value: "wss://other.example/" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Move to community" }));
  await waitFor(() => expect(moved).toHaveBeenCalledOnce());
  expect(communityRequest).toHaveBeenCalledWith(
    "https://other.example",
    "resolve-agent-community",
    { pubkey: f.agent.pubkey, owner, confirmed: true },
  );
  expect(move).toHaveBeenCalledWith(f.agent.id, f.agent.revision, resolution);
  control.dispose();
});

it("does not move a running agent or bypass owner verification failure", async () => {
  const f = controlFixture();
  const move = vi.fn();
  f.host.moveCommunity = move;
  const control = createAgentControl(f.host);
  await control.refresh();
  const props = {
    agent: f.agent,
    control,
    owner: "cd".repeat(32),
    disabled: false,
    onMoved: vi.fn(),
  };
  const view = render(<MoveAgentCommunity {...props} />);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Destination community" }),
    { target: { value: "wss://other.example" } },
  );
  expect(
    screen.getByRole("button", { name: "Move to community" }),
  ).toBeDisabled();
  Object.assign(f.agent, {
    enabled: false,
    status: "stopped",
    runningRevision: null,
  });
  view.rerender(<MoveAgentCommunity {...props} />);
  vi.mocked(communityRequest).mockRejectedValue(
    new Error("Owner does not match"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Move to community" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Owner does not match",
  );
  expect(move).not.toHaveBeenCalled();
  expect(props.onMoved).not.toHaveBeenCalled();
  control.dispose();
});
