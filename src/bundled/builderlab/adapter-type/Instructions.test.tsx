// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { RelayData } from "../../../features/relay/service";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentTabs } from "../../agents/AgentTabs";
import type { Agents, Agent } from "../../../features/agents/service";
import type { HostResponse } from "../../../features/host/service";
import { createAgentClient } from "../agents/client";
import { federatedFixture } from "../../../features/federated-identity/testing";
import { createBuilderlabSession } from "../session";
import { deferred } from "../test-helpers";
import { builderlabType } from "./index";

const first = "ab".repeat(32);
const second = "cd".repeat(32);
const agent = (pubkey = first): Agent => ({
  pubkey,
  name: "Helper",
  type: "block.builderlab/builderlab",
  owner: "ef".repeat(32),
  relay: "wss://community.example",
  place: "hosted",
  config: {},
  attention: {},
  skipped: {},
  attentionEnabled: true,
  timers: {},
});
const response = (): HostResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    status: 1,
    agents: [
      {
        agent_id: "one",
        agent_pubkey: first,
        agent_name: "Helper",
        status: 2,
        agent_instructions: "First instructions.",
      },
      {
        agent_id: "two",
        agent_pubkey: second,
        agent_name: "Other",
        status: 2,
        agent_instructions: "Second instructions.",
      },
    ],
  }),
});
afterEach(cleanup);
function fixture() {
  const federated = federatedFixture("user", "account-a");
  const session = createBuilderlabSession(federated.session);
  const request = federated.request.mockResolvedValue(response());
  const client = createAgentClient(session);
  const type = {
    ...builderlabType(client, session, {
      snapshot: () => ({ status: "disconnected", generation: 0 }),
      subscribe: () => () => {},
    } as unknown as RelayData),
    key: "block.builderlab/builderlab",
    pluginId: "block.builderlab",
    revision: "test",
  };
  const Tab = type.tabs?.[0]?.component;
  if (!Tab) throw new Error("Missing Builderlab settings");
  return {
    Tab,
    type,
    request,
    signOut: () => session.signOut(),
    changeAccount: () => {
      void session.signOut();
      vi.mocked(federated.service.signIn).mockImplementation(async () => {
        federated.publish({
          status: "signed-in",
          revision: "user:b",
          email: "account-b",
        });
        return federated.service.snapshot();
      });
    },
  };
}
it("retries a failed load and refuses to save a draft through another account", async () => {
  const h = fixture();
  const user = userEvent.setup();
  h.request.mockRejectedValueOnce(new Error("offline"));
  render(<h.Tab agent={agent()} save={vi.fn()} />, { wrapper: StrictMode });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  const field = await screen.findByRole("textbox", { name: "Instructions" });
  expect(field).toHaveValue("First instructions.");
  await user.type(field, "Changed.");
  await act(async () => h.changeAccount());
  const before = h.request.mock.calls.length;
  await user.click(screen.getByRole("button", { name: "Save instructions" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "account that loaded these instructions",
  );
  expect(h.request).toHaveBeenCalledTimes(before);
  expect(field).toHaveValue("First instructions.Changed.");
});
it("switching agents hides the old draft and ignores the switched-away read", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const mounted = render(<h.Tab agent={agent()} save={vi.fn()} />, {
    wrapper: StrictMode,
  });
  const field = await screen.findByRole("textbox", { name: "Instructions" });
  await user.type(field, "Unsaved.");
  const delayed = deferred<HostResponse>();
  h.request.mockReturnValueOnce(delayed.promise);
  try {
    mounted.rerender(<h.Tab agent={agent(second)} save={vi.fn()} />);
    await waitFor(() => expect(h.request).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading instructions",
    );
    expect(
      screen.queryByRole("textbox", { name: "Instructions" }),
    ).not.toBeInTheDocument();
    mounted.rerender(<h.Tab agent={agent()} save={vi.fn()} />);
    expect(
      await screen.findByRole("textbox", { name: "Instructions" }),
    ).toHaveValue("First instructions.");
  } finally {
    await act(async () => {
      delayed.resolve(response());
      await delayed.promise;
    });
  }
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
    "First instructions.",
  );
});

it("retains a hosted instructions draft and failed save across profile tabs", async () => {
  const h = fixture();
  const user = userEvent.setup();
  render(
    <AgentTabs
      agents={{ save: vi.fn() } as unknown as Agents}
      agent={agent()}
      type={h.type}
      channels={[]}
      memories={undefined}
      settingsHost={{ typeControl: () => <p>Hosted provider</p> }}
      settingsContent={<p>Agent settings</p>}
    />,
    { wrapper: StrictMode },
  );
  expect(screen.queryByRole("tab", { name: "Instructions" })).toBeNull();
  const field = await screen.findByRole("textbox", { name: "Instructions" });
  expect(screen.getByRole("link", { name: "Builderlab" })).toHaveAttribute(
    "href",
    "https://builderlab.example",
  );
  await user.type(field, " Unsaved.");
  const reads = h.request.mock.calls.length;
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
  expect(screen.getByText("Workspace")).toBeVisible();
  expect(screen.getByText("One session per thread")).toBeVisible();
  expect(screen.getByText("Agent settings")).toBeVisible();
  expect(screen.getByRole("link", { name: "Builderlab" })).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  expect(screen.getByRole("textbox", { name: "Instructions" })).toBe(field);
  expect(field).toHaveValue("First instructions. Unsaved.");
  expect(screen.queryByText("Workspace")).toBeNull();
  expect(h.request).toHaveBeenCalledTimes(reads);
  h.request.mockRejectedValueOnce(new Error("offline"));
  await user.click(screen.getByRole("button", { name: "Save instructions" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  expect(field).toHaveValue("First instructions. Unsaved.");
  expect(
    screen.getByRole("button", { name: "Save instructions" }),
  ).toBeEnabled();
});
it("links to the signed-in NIP-FI origin and hides the link without one", async () => {
  const h = fixture();
  render(<h.Tab agent={agent()} save={vi.fn()} />);
  expect(screen.getByRole("link", { name: "Builderlab" })).toHaveAttribute(
    "href",
    "https://builderlab.example",
  );
  await act(async () => h.signOut());
  expect(screen.queryByRole("link", { name: "Builderlab" })).toBeNull();
});
