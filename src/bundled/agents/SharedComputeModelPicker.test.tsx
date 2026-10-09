// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SharedComputeModelPicker } from "./SharedComputeModelPicker";
import { agentDraft } from "./agent-edit";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";

afterEach(cleanup);

it("offers Auto and discovered models without cloud settings or custom entry", async () => {
  const f = controlFixture();
  const run = vi.fn(async () => ({
    host: "",
    models: [{ id: "community-model", name: "Community model" }],
    modelOverridden: false,
    disconnected: false,
  }));
  f.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(f.host);
  const user = userEvent.setup();
  function Editor() {
    const [draft, setDraft] = useState({
      ...agentDraft(f.agent),
      command: "buzz-agent",
      provider: "relay-mesh",
      model: "auto",
    });
    return (
      <SharedComputeModelPicker
        draft={draft}
        control={control}
        disabled={false}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      />
    );
  }
  const view = render(<Editor />);
  try {
    await screen.findByText(/No API key required/);
    expect(run).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ host: "", filter: "", action: "connect" }),
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(
      await screen.findByRole("option", { name: "Community model" }),
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "Community model",
    );
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Model" })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(
      await screen.findByRole("option", {
        name: "Auto (collective when available)",
      }),
    );
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("retains saved selection on failure and retries to an empty catalog with Auto", async () => {
  const f = controlFixture();
  const run = vi
    .fn()
    .mockRejectedValueOnce("Community unavailable")
    .mockResolvedValue({
      host: "",
      models: [],
      modelOverridden: false,
      disconnected: false,
    });
  f.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(f.host);
  const change = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <SharedComputeModelPicker
      id={f.agent.id}
      draft={{
        ...agentDraft(f.agent),
        command: "buzz-agent",
        provider: "relay-mesh",
        model: "saved-model",
      }}
      control={control}
      disabled={false}
      onChange={change}
    />,
  );
  try {
    await screen.findByText("Community unavailable");
    expect(run).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({
        id: f.agent.id,
        expectedRevision: f.agent.revision,
        edit: expect.objectContaining({ name: "Model discovery" }),
      }),
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "saved-model",
    );
    expect(change).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Retry models" }));
    await screen.findByText(/No shared models advertised yet/);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(change).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("keeps incomplete arguments editable and only refetches discovery inputs", async () => {
  const f = controlFixture();
  const run = vi.fn(async () => ({
    host: "",
    models: [],
    modelOverridden: false,
    disconnected: false,
  }));
  f.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(f.host);
  let draft = {
    ...agentDraft(f.agent),
    command: "buzz-agent",
    provider: "relay-mesh",
    model: "auto",
  };
  const props = { control, disabled: false, onChange: vi.fn() };
  const view = render(<SharedComputeModelPicker {...props} draft={draft} />);
  try {
    await screen.findByText(/No shared models advertised yet/);
    expect(run).toHaveBeenCalledTimes(1);
    draft = {
      ...draft,
      name: "New name",
      systemPrompt: "New instructions",
      model: "saved",
    };
    view.rerender(<SharedComputeModelPicker {...props} draft={draft} />);
    expect(run).toHaveBeenCalledTimes(1);
    draft = { ...draft, args: "[" };
    view.rerender(<SharedComputeModelPicker {...props} draft={draft} />);
    await screen.findByText("Arguments must be a JSON array of strings.");
    expect(run).toHaveBeenCalledTimes(1);
    draft = { ...draft, args: '["--verbose"]' };
    view.rerender(<SharedComputeModelPicker {...props} draft={draft} />);
    await screen.findByText(/No shared models advertised yet/);
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    control.dispose();
  }
});
