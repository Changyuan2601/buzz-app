// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import { MeshHelpers } from "./MeshHelpers";
import { DEFAULT_MESH_AGENT_CONFIG } from "./meshAgent";
import { MESH_AGENT_PRESETS } from "./meshAgentPresets";

afterEach(cleanup);
const type = {
  id: "mesh",
  key: "buzz.mesh-compute/mesh",
  pluginId: "buzz.mesh-compute",
  title: "Mesh",
  revision: "1",
  defaults: () => ({ config: DEFAULT_MESH_AGENT_CONFIG }),
} as RegisteredAgentType;
function setup(status = "ready") {
  const create = vi.fn(
    async (input) => ({ ...input, pubkey: "a".repeat(64) }) as Agent,
  );
  const state = { status, agents: [], running: [], teams: [] };
  const agents = {
    snapshot: () => state,
    subscribe: () => () => {},
    types: () => [type],
    create,
  } as unknown as Agents;
  render(<MeshHelpers agents={agents} community="https://relay.example" />);
  return { create, user: userEvent.setup() };
}
it("offers all four helpers and custom without creating an agent on selection", async () => {
  const { create, user } = setup();
  for (const preset of MESH_AGENT_PRESETS)
    expect(
      screen.getByRole("button", { name: `Set up ${preset.name}` }),
    ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Set up Custom agent" }),
  ).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Set up Emoji maker" }));
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Emoji maker");
  expect(within(dialog).getByLabelText("Instructions")).toHaveValue(
    MESH_AGENT_PRESETS[0]?.prompt,
  );
  expect(create).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(create).not.toHaveBeenCalled();
});
it("reviews and customises a helper's instructions, mode, workspace and session scope before creation", async () => {
  const { create, user } = setup();
  await user.click(screen.getByRole("button", { name: "Set up Translator" }));
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Thomas's helper" },
  });
  fireEvent.change(within(dialog).getByLabelText("Instructions"), {
    target: { value: "Custom task" },
  });
  await user.click(within(dialog).getByRole("combobox", { name: "Mode" }));
  await user.click(
    await screen.findByRole("option", { name: "Workspace — shell and files" }),
  );
  fireEvent.change(within(dialog).getByLabelText("Workspace"), {
    target: { value: "/tmp/helper" },
  });
  await user.click(within(dialog).getByRole("combobox", { name: "Sessions" }));
  await user.click(
    await screen.findByRole("option", { name: "One session per channel" }),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Create agent" }),
  );
  expect(create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      type: type.key,
      name: "Thomas's helper",
      config: expect.objectContaining({
        prompt: "Custom task",
        mode: "workspace",
        workspace: "/tmp/helper",
        scope: "channel",
      }),
    }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Thomas's helper created",
  );
});
it("keeps creation unavailable while agents are loading", () => {
  setup("loading");
  for (const button of screen.getAllByRole("button"))
    expect(button).toBeDisabled();
});
