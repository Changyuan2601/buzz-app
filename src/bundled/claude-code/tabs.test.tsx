// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent, AgentType } from "../../features/agents2/service";
import type { HostProcessOptions } from "../../features/host/service";
import { apply, inject } from "./index";
import { type Config, DEFAULT_CONFIG } from "./runtime";

const desktop = vi.hoisted(() => ({ tauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => desktop.tauri }));

beforeEach(() => {
  desktop.tauri = true;
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const agent = (config: Config = DEFAULT_CONFIG) =>
  ({
    pubkey: "c".repeat(64),
    name: "Claude",
    type: "buzz.claude-code/claude-code",
    owner: "a".repeat(64),
    config,
  }) as Agent<Config>;

// jsdom leaves focus on a button that becomes natively disabled, where a
// browser drops it, so the focus tests also check for no `disabled`.

/** Applies the plugin to a stand-in context; sign-in runs until killed. */
function applied({ loggedIn = true } = {}) {
  let type: AgentType<Config> | undefined;
  const spawn = vi.fn(async (_id: string, options: HostProcessOptions = {}) => {
    const args = (options.args ?? []).join(" ");
    let kill: () => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      if (args === "auth login") kill = () => resolve(null);
      else setTimeout(() => resolve(0), 0);
    });
    queueMicrotask(() =>
      options.onStdout?.(
        args === "--version"
          ? "2.1.292 (Claude Code)\n"
          : args === "auth status --json"
            ? JSON.stringify({ loggedIn, email: "me@example.com" })
            : "",
      ),
    );
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => kill(),
      exited,
    };
  });
  const ctx = {
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: { spawn, request: vi.fn() },
    agents2: {
      register: (registered: AgentType<Config>) => {
        type = registered;
      },
      snapshot: () => ({ status: "ready", agents: [], running: [] }),
      relay: () => undefined,
      subscribe: () => () => undefined,
    },
    effect: vi.fn(),
  };
  apply(ctx as never);
  return { type, spawn };
}
function installed(options?: { loggedIn?: boolean }) {
  const { type, spawn } = applied(options);
  if (!type) throw new Error("no type registered");
  return { type, spawn };
}
function tab(type: AgentType<Config>, index: number) {
  const component = type.tabs?.[index]?.component;
  if (!component) throw new Error("no tab");
  return component;
}
async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

it("is an agent type on the desktop app", () => {
  expect(inject).toEqual(["agents2", "host"]);
  const { type } = installed();
  expect(type).toMatchObject({ id: "claude-code", title: "Claude Code" });
  expect(type.defaults()).toEqual({ config: DEFAULT_CONFIG });
  expect(type.summary?.(agent({ ...DEFAULT_CONFIG, model: "opus" }))).toBe(
    "opus",
  );
  expect(type.tabs?.map((tab) => tab.title)).toEqual(["Claude", "Settings"]);
});

it("registers only where setup's bash and base64 exist", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  expect(applied().type).toBeDefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  expect(applied().type).toBeUndefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  desktop.tauri = false;
  expect(applied().type).toBeUndefined();
});

it("shows that Claude Code is ready and that nothing is running yet", async () => {
  const Claude = tab(installed().type, 0);
  render(<Claude agent={agent()} save={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Claude Code 2.1.292 is ready (me@example.com).",
    ),
  );
  expect(
    screen.getByText(/None\. A conversation's session starts/),
  ).toBeVisible();
});

it("keeps focus on sign-in while it runs and on the same button after cancel", async () => {
  const Claude = tab(installed({ loggedIn: false }).type, 0);
  render(<Claude agent={agent()} save={vi.fn()} />);
  const user = userEvent.setup();
  const signIn = await screen.findByRole("button", { name: "Sign in" });
  await user.click(signIn);
  await waitFor(() => expect(signIn).toHaveAttribute("aria-busy", "true"));
  expect(signIn).toHaveFocus();
  expect(signIn).not.toHaveAttribute("disabled");
  expect(screen.getByLabelText("Sign-in code")).toHaveAccessibleDescription(
    "If the browser shows a code to paste, enter it here.",
  );
  const cancel = screen.getByRole("button", { name: "Cancel" });
  await user.click(cancel);
  await waitFor(() => expect(cancel).toHaveTextContent("Check again"));
  expect(cancel).toHaveFocus();
  expect(cancel).not.toHaveAttribute("disabled");
});

it("saves settings as one config and warns before answering anyone", async () => {
  const Settings = tab(installed().type, 1);
  const save = vi.fn(async () => undefined);
  render(<Settings agent={agent()} save={save} />);
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await choose("Model", "Sonnet");
  await choose("Answers", "Anyone who mentions it");
  expect(screen.getByText(/with no approval step/)).toBeVisible();
  expect(screen.getByLabelText("Workspace")).toHaveAccessibleDescription(
    "The folder Claude Code works in. Use ~/ for your home folder.",
  );
  await user.clear(screen.getByLabelText("Workspace"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({
    ...DEFAULT_CONFIG,
    model: "sonnet",
    respondTo: "anyone",
    workspace: "~/.buzz",
  });
});

it("keeps Save focused while saving, and lets a failed save be retried", async () => {
  const Settings = tab(installed().type, 1);
  let fail: (error: Error) => void = () => undefined;
  const save = vi
    .fn<(config: Config) => Promise<void>>()
    .mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = reject)),
    )
    .mockResolvedValueOnce(undefined);
  render(<Settings agent={agent()} save={save} />);
  const user = userEvent.setup();
  await choose("Model", "Haiku");
  const saveButton = screen.getByRole("button", { name: "Save" });
  await user.click(saveButton);
  expect(saveButton).toHaveAttribute("aria-busy", "true");
  expect(saveButton).toHaveFocus();
  expect(saveButton).not.toHaveAttribute("disabled");
  fail(new Error("Relay rejected the change"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Relay rejected the change",
  );
  expect(saveButton).toHaveFocus();
  await user.click(saveButton);
  expect(save).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
