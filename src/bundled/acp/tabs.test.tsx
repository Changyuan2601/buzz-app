// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "../../features/agents/service";
import { approved, type Config, DEFAULT_CONFIG } from "./config";
import { createTabs } from "./tabs";

afterEach(cleanup);

const start: Config = {
  ...DEFAULT_CONFIG,
  command: "cursor-agent",
  args: ["acp"],
  env: { CURSOR_API_KEY: "hunter2", PATH: "/opt/bin" },
};

function mount(check = vi.fn(async () => "Ready."), initial = start) {
  const { SettingsTab } = createTabs({ check });
  const saves: Config[] = [];
  function Host() {
    const [config, setConfig] = useState(initial);
    return (
      <SettingsTab
        agent={{ config } as Agent<Config>}
        save={async (next) => {
          saves.push(next);
          setConfig(next);
        }}
      />
    );
  }
  render(<Host />);
  return { saves, check };
}

it("confirms the exact launch without showing env values other than PATH", async () => {
  const { saves, check } = mount();
  expect(screen.getByRole("button", { name: "Check" })).toBeDisabled();
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm command" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent('["cursor-agent","acp"]');
  expect(dialog).toHaveTextContent("CURSOR_API_KEY");
  expect(dialog).toHaveTextContent("PATH=/opt/bin");
  expect(dialog).not.toHaveTextContent("hunter2");
  await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(await approved(saves[0] as Config)).toBe(true);
  const checkButton = screen.getByRole("button", { name: "Check" });
  await waitFor(() => expect(checkButton).toBeEnabled());
  await userEvent.click(checkButton);
  expect(check).toHaveBeenCalledWith(saves[0]);
  expect(await screen.findByRole("status")).toHaveTextContent("Ready.");
});

it("drops the approval when a launch setting is saved changed", async () => {
  const { saves } = mount();
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm command" }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(saves).toHaveLength(1));
  const args = screen.getByRole("textbox", { name: "Arguments" });
  await userEvent.type(args, "\n--force");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saves).toHaveLength(2));
  expect(saves[1]).toMatchObject({ args: ["acp", "--force"], approval: "" });
  expect(screen.getByRole("button", { name: "Check" })).toBeDisabled();
});

it("won't save a reserved env name", async () => {
  mount();
  await userEvent.click(screen.getByRole("button", { name: "Add variable" }));
  const names = screen.getAllByRole("textbox", { name: "Name" });
  await userEvent.type(names.at(-1) as HTMLElement, "BUZZ_PRIVATE_KEY");
  expect(screen.getByRole("alert")).toHaveTextContent("reserved for Buzz");
  expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

it("needs a new confirmation after switching preset away and back", async () => {
  const { saves } = mount();
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm command" }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(saves).toHaveLength(1));
  const check = screen.getByRole("button", { name: "Check" });
  await waitFor(() => expect(check).toBeEnabled());
  for (const name of [/OpenCode/, /Cursor/]) {
    await userEvent.click(screen.getByRole("combobox", { name: "Harness" }));
    await userEvent.click(await screen.findByRole("option", { name }));
  }
  expect(check).toBeDisabled();
  expect(
    screen.getByText(
      "This command needs your confirmation before the agent can run.",
    ),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saves).toHaveLength(2));
  expect(saves[1]).toMatchObject({ preset: "cursor", approval: "" });
});

it.each([[["a\nb"]], [[""]]])(
  "won't silently rewrite stored args %j the box can't show",
  async (stored) => {
    const { saves } = mount(undefined, { ...start, args: stored });
    const save = screen.getByRole("button", { name: "Save" });
    expect(screen.getByRole("alert")).toHaveTextContent("can't be empty");
    expect(save).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(save);
    expect(saves).toHaveLength(0);
    const args = screen.getByRole("textbox", { name: "Arguments" });
    await userEvent.clear(args);
    await userEvent.type(args, "acp");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(save);
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({ args: ["acp"] });
  },
);
