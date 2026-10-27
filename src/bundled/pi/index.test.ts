// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { appliedType } from "../../features/agents/plugin-testing";
import * as pi from "./index";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

it("shows the Pi type's screens from the runtime its agent entry registers", () => {
  // The UI needs no host; only the runtime starts Pi.
  expect(pi.inject).toEqual(["agents"]);
  expect(pi.agent.inject).toEqual(["agents", "host"]);
  const type = appliedType(pi, {
    pluginOwner: { id: "buzz.pi", revision: "r1" },
    host: { request: vi.fn() },
    agents: { relay: () => undefined },
    effect: vi.fn(),
  });
  expect(type).toMatchObject({ id: "pi", title: "Pi", timeoutMs: 120_000 });
  expect(type?.Create).toBeTypeOf("function");
  expect(type?.CreateModel).toBeTypeOf("function");
  expect(type?.icon).toBeDefined();
  expect(type?.tabs?.map((tab) => tab.id)).toEqual(["settings", "activity"]);
});
