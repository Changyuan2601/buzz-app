// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { AgentSettings } from "./AgentSettings";
import {
  rememberAgentsPreference,
  setRememberAgentsPreference,
} from "../features/messages/mention-preferences";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setRememberAgentsPreference(true);
  localStorage.clear();
});

it("defaults on, persists opt-out, and follows another window's preference", async () => {
  const user = userEvent.setup();
  render(<AgentSettings />, {
    wrapper: ToastProvider,
  });
  const toggle = () =>
    screen.getByRole("switch", { name: "Remember mentioned agents" });
  expect(toggle()).toBeChecked();
  await user.click(toggle());
  expect(rememberAgentsPreference()).toBe(false);
  cleanup();
  render(<AgentSettings />, {
    wrapper: ToastProvider,
  });
  expect(toggle()).not.toBeChecked();
  act(() => {
    localStorage.removeItem("buzz-remember-mentioned-agents.v1");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "buzz-remember-mentioned-agents.v1" }),
    );
  });
  expect(toggle()).toBeChecked();
});

it("keeps an unsaved opt-out effective and offers retry without changing the choice", async () => {
  const user = userEvent.setup();
  const view = render(<AgentSettings />, {
    wrapper: ToastProvider,
  });
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("storage unavailable");
    });
  await user.click(
    screen.getByRole("switch", { name: "Remember mentioned agents" }),
  );
  expect(rememberAgentsPreference()).toBe(false);
  expect(screen.getByRole("dialog")).toHaveTextContent("could not be saved");
  view.rerender(<AgentSettings active={false} />);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  view.rerender(<AgentSettings />);
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "could not be saved",
  );
  write.mockRestore();
  await user.click(
    screen.getByRole("button", { name: "Retry saving mentioned agents" }),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(localStorage.getItem("buzz-remember-mentioned-agents.v1")).toBe("off");
});

it("does not prefill when storage cannot be read", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  expect(rememberAgentsPreference()).toBe(false);
});

it("places keep-awake beside tagging, starts off, and reflects native work, expiry and failure recovery", async () => {
  const { createKeepAwake } = await import("../features/agents/keep-awake");
  let changed = (
    _state: import("../features/agents/keep-awake").PowerState,
  ) => {};
  let fail = false;
  const keepAwake = createKeepAwake({
    open: async (listener) => {
      changed = listener;
      return 1;
    },
    set: async (_lease, active) => {
      if (fail) throw new Error("System refused sleep prevention");
      return { supported: true, active, expired: false };
    },
  });
  const emptyTypes: never[] = [];
  const user = userEvent.setup();
  render(
    <AgentSettings
      agents={
        {
          keepAwake,
          subscribe: () => () => {},
          types: () => emptyTypes,
        } as unknown as import("../features/agents/service").Agents
      }
    />,
    {
      wrapper: ToastProvider,
    },
  );
  const toggle = screen.getByRole("switch", {
    name: "Keep awake while local agents work",
  });
  expect(toggle).not.toBeChecked();
  expect(toggle).toHaveAccessibleDescription(
    "Prevent automatic sleep while local agents work on this computer. Displays can still sleep.",
  );
  expect(toggle.closest(".buzz-settings-group")).toContainElement(
    screen.getByRole("switch", { name: "Remember mentioned agents" }),
  );
  await user.click(toggle);
  expect(toggle).toBeChecked();
  await screen.findByText(/Waiting for local agent work/);
  let work!: ReturnType<typeof keepAwake.begin>;
  act(() => {
    work = keepAwake.begin(new AbortController().signal);
  });
  await screen.findByText(/Sleep prevention is active/);
  act(() => changed({ supported: true, active: false, expired: true }));
  expect(screen.getByText(/paused after one hour/)).toBeInTheDocument();
  fail = true;
  act(() => work.pulse());
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "System refused sleep prevention",
  );
  fail = false;
  await user.click(
    screen.getByRole("button", { name: "Retry keep-awake setting" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await act(async () => {
    work.finish();
    await keepAwake.dispose();
  });
});
