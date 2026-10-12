// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentType } from "../../features/agents/service";
import type { HostProcessOptions } from "../../features/host/service";
import { defaults } from "./config";
import { CodexRuntime } from "./runtime";
import { apply } from "./index";

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

/** Applies the plugin to a stand-in context and returns the registered type. */
function applied(spawn = vi.fn()) {
  let type: AgentType | undefined;
  const subscribe = () => () => undefined;
  const ctx = {
    pluginOwner: { id: "buzz.codex", revision: "r1" },
    host: { spawn, request: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      snapshot: () => ({ status: "ready", agents: [], running: [] }),
      relay: () => undefined,
      subscribe,
    },
    effect: vi.fn(),
  };
  apply(ctx as never);
  return type;
}

it("registers only where the desktop app can run codex and base64", () => {
  expect(applied()).toMatchObject({
    id: "codex",
    title: "Codex",
    Create: expect.any(Function),
  });
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  expect(applied()).toBeDefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  expect(applied()).toBeUndefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  desktop.tauri = false;
  expect(applied()).toBeUndefined();
});

it("adopts a brought-over agent's instructions and workspace, nothing else", () => {
  const type = applied();
  const saved = type?.defaults().config;
  expect(
    type?.adopt?.({ instructions: "Triage.", model: "gpt" } as never, saved),
  ).toEqual({ ...(saved as object), instructions: "Triage." });
  expect(type?.adopt?.({ workspace: "/work/code" }, saved)).toEqual({
    ...(saved as object),
    workspace: "/work/code",
  });
  // A workspace Codex cannot run in stays the default.
  expect(type?.adopt?.({ workspace: "~/code" }, saved)).toEqual(saved);
});

it("stops agents that stop running even when the agent list could not be read", () => {
  const sync = vi.spyOn(CodexRuntime.prototype, "sync");
  const agent = { pubkey: "agent", type: "buzz.codex/codex" };
  let state = { status: "ready", agents: [agent], running: [agent] };
  let notify = () => undefined;
  apply({
    pluginOwner: { id: "buzz.codex" },
    host: { spawn: vi.fn(), request: vi.fn() },
    agents: {
      register: () => undefined,
      snapshot: () => state,
      relay: () => undefined,
      subscribe: (listener: () => undefined) => {
        notify = listener;
        return () => undefined;
      },
    },
    effect: vi.fn(),
  } as never);
  expect(sync).toHaveBeenLastCalledWith([agent]);
  // A failed refresh keeps the list; leaving the community then empties it.
  state = { ...state, status: "error", agents: [], running: [] };
  notify();
  expect(sync).toHaveBeenLastCalledWith([]);
});

it("renews agents' server when sign-in finishes after its tab has closed", async () => {
  const reauthorize = vi
    .spyOn(CodexRuntime.prototype, "reauthorize")
    .mockResolvedValue();
  let finish!: (code: number) => void;
  const login = new Promise<number>((done) => {
    finish = done;
  });
  const spawn = vi.fn(async (id: string, options?: HostProcessOptions) => {
    let end!: (code: number) => void;
    const ended = new Promise<number>((done) => {
      end = done;
    });
    return {
      // A signed-out Codex: every request succeeds, and there is no account.
      write: async (text: string) => {
        const { id: request, method } = JSON.parse(text);
        if (request == null) return;
        const result = method === "account/read" ? { account: null } : {};
        options?.onStdout?.(`${JSON.stringify({ id: request, result })}\n`);
      },
      end: async () => end(0),
      kill: async () => end(1),
      exited: id === "login" ? login : ended,
    };
  });
  const tab = applied(spawn)?.tabs?.find((tab) => tab.id === "codex");
  if (!tab) throw new Error("Missing Codex tab");
  const view = render(
    createElement(tab.component, {
      agent: { pubkey: "a".repeat(64), config: defaults },
      save: vi.fn(),
    } as never),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  await waitFor(() =>
    expect(spawn).toHaveBeenCalledWith("login", expect.anything()),
  );
  // Leaving the editor unmounts the tab while the browser sign-in continues.
  view.unmount();
  expect(reauthorize).not.toHaveBeenCalled();
  finish(0);
  await waitFor(() => expect(reauthorize).toHaveBeenCalledTimes(1));
});
