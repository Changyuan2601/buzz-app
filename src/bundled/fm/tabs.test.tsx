// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "../../features/agents/service";
import { type Config, DEFAULT_CONFIG } from "./runtime";
import { createTabs } from "./tabs";

afterEach(cleanup);

const AGENT = {
  pubkey: "c".repeat(64),
  name: "Orchard",
  type: "buzz.fm/fm",
  owner: "a".repeat(64),
  config: { ...DEFAULT_CONFIG, instructions: "Be brief." },
} as Agent<Config>;

it("saves the agent's instructions", async () => {
  const available = vi.fn(async () => ({
    ready: true,
    detail: "System model available",
  }));
  const { SettingsTab } = createTabs({ available });
  const save = vi.fn(async () => {});
  render(<SettingsTab agent={AGENT} save={save} />);
  expect(
    await screen.findByText(/Apple's on-device model is ready/),
  ).toBeVisible();
  const user = userEvent.setup();
  const field = screen.getByRole("textbox", { name: "Instructions" });
  await user.clear(field);
  await user.type(field, "Answer in French.");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({ instructions: "Answer in French." });
});

it("says why the model can't answer, and checks again", async () => {
  const available = vi
    .fn()
    .mockResolvedValueOnce({
      ready: false,
      detail: "System model unavailable: Apple Intelligence is not enabled.",
    })
    .mockResolvedValueOnce({ ready: true, detail: "System model available" });
  const { Create } = createTabs({ available });
  render(
    <Create config={DEFAULT_CONFIG} onChange={() => {}} disabled={false} />,
  );
  expect(
    await screen.findByText(/Apple Intelligence is not enabled/),
  ).toBeVisible();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Check again" }));
  expect(
    await screen.findByText(/Apple's on-device model is ready/),
  ).toBeVisible();
  expect(available).toHaveBeenCalledTimes(2);
});

it("splits identity from runtime settings, with the host's rows in runtime", async () => {
  const available = vi.fn(async () => ({
    ready: true,
    detail: "System model available",
  }));
  const { SettingsTab } = createTabs({ available });
  const props = {
    agent: AGENT,
    save: vi.fn(async () => {}),
    settingsContent: <p>Host rows</p>,
  };
  const { rerender } = render(
    <SettingsTab {...props} settingsSection="identity" />,
  );
  expect(screen.getByRole("textbox", { name: "Instructions" })).toBeVisible();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText("Host rows")).toBeNull();
  rerender(<SettingsTab {...props} settingsSection="runtime" />);
  expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
  expect(
    await screen.findByText(/Apple's on-device model is ready/),
  ).toBeVisible();
  expect(screen.getByText("Host rows")).toBeVisible();
});
