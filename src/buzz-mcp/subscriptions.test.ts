import { expect, it, vi } from "vitest";
import { appClient } from "./app-client";
import { respond } from "./rpc";
import type { AgentHandle } from "../features/agents/service";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  isTauri: () => true,
}));

it("launches a PR subscription through native custody with the bound owner and route", async () => {
  const agent = {
    pubkey: "a".repeat(64),
    owner: "b".repeat(64),
  } as AgentHandle;
  const context = {
    channel: "34aeaccc-c83b-4422-beac-a4b8661f9f59",
    root: "c".repeat(64),
  };
  native.invoke.mockResolvedValue({
    id: "subscription",
    status: "running",
    baseline: "head-sha",
  });
  const client = appClient(agent, {
    cwd: "/workspace",
    spawn: vi.fn(),
    memories: vi.fn(),
  });
  const response = await respond(client, context, {
    id: 1,
    method: "tools/call",
    params: {
      name: "subscribe_pr",
      arguments: { repo: "block/buzz-app", pr: 677 },
    },
  });
  expect(response).toMatchObject({
    result: {
      content: [
        { type: "text", text: expect.stringContaining("subscription") },
      ],
    },
  });
  expect(response).not.toHaveProperty("result.isError");
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith(
    "app_agent_subscribe_pr",
    {
      pubkey: agent.pubkey,
      owner: agent.owner,
      ...context,
      repo: "block/buzz-app",
      pr: 677,
    },
  );
});
