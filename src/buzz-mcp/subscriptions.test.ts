import { expect, it, vi } from "vitest";
import { nativeAgents } from "../features/agents/native";
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
    subscribePr: (channel: string, root: string, repo: string, pr: number) =>
      nativeAgents()?.subscribePr?.(
        "a".repeat(64),
        "b".repeat(64),
        channel,
        root,
        repo,
        pr,
      ),
  } as AgentHandle;
  const context = {
    channel: "00000000-0000-4000-8000-000000000001",
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

it.each(["pubkey", "owner", "channel", "root", "producer"])(
  "rejects a supplied %s override before native startup",
  async (override) => {
    native.invoke.mockClear();
    const client = appClient(
      { pubkey: "a".repeat(64), owner: "b".repeat(64) } as AgentHandle,
      { cwd: "/workspace", spawn: vi.fn(), memories: vi.fn() },
    );
    const response = await respond(
      client,
      { channel: "bound", root: "c".repeat(64) },
      {
        id: 1,
        method: "tools/call",
        params: {
          name: "subscribe_pr",
          arguments: { repo: "block/buzz-app", pr: 677, [override]: "wrong" },
        },
      },
    );
    expect(response).toMatchObject({ result: { isError: true } });
    expect(native.invoke).not.toHaveBeenCalled();
  },
);

it("does not start an undeliverable producer when native transport is unavailable", async () => {
  const client = {
    pubkey: "a".repeat(64),
  } as unknown as import("./client").BuzzClient;
  const response = await respond(
    client,
    { channel: "bound", root: "c".repeat(64) },
    {
      id: 1,
      method: "tools/call",
      params: {
        name: "subscribe_pr",
        arguments: { repo: "block/buzz-app", pr: 677 },
      },
    },
  );
  expect(response).toMatchObject({
    result: {
      isError: true,
      content: [{ text: "Native PR subscription transport unavailable" }],
    },
  });
});
