// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentType } from "../../features/agents2/service";
import { apply } from "./index";

const desktop = vi.hoisted(() => ({ tauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => desktop.tauri }));

beforeEach(() => {
  desktop.tauri = true;
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Applies the plugin to a stand-in context and returns the registered type. */
function applied() {
  let type: AgentType | undefined;
  const subscribe = () => () => undefined;
  const ctx = {
    react: React,
    pluginOwner: { id: "buzz.codex", revision: "r1" },
    host: { spawn: vi.fn(), request: vi.fn() },
    agents2: {
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
  expect(applied()).toMatchObject({ id: "codex", title: "Codex" });
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  expect(applied()).toBeDefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  expect(applied()).toBeUndefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  desktop.tauri = false;
  expect(applied()).toBeUndefined();
});
