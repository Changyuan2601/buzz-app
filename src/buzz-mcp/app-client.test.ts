import { expect, it, vi } from "vitest";
import type { AgentHandle } from "../features/agents/service";
import { appClient } from "./app-client";

it("carries connection authorities independently of query event authors", async () => {
  const query = vi.fn(async () => []);
  const client = appClient(
    { pubkey: "agent", query } as unknown as AgentHandle,
    {
      read: vi.fn(),
      memories: async () => ({ entries: [], partial: false }),
      relayAuthor: "trusted-relay",
      signingAuthority: "trusted-workflows",
    },
  );
  expect(client.relayAuthor).toBe("trusted-relay");
  expect(client.signingAuthority).toBe("trusted-workflows");
  await client.query([{ kinds: [39000] }]);
  expect(query).toHaveBeenCalledWith([{ kinds: [39000] }]);
});

it("does not invent authority when a host has none", () => {
  const client = appClient({ pubkey: "agent" } as AgentHandle, {
    read: vi.fn(),
    memories: async () => ({ entries: [], partial: false }),
  });
  expect(client.relayAuthor).toBeUndefined();
  expect(client.signingAuthority).toBeUndefined();
});

it("withholds a query result when the owning turn ends during the read", async () => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const query = vi.fn(async () => {
    await pending;
    return [];
  });
  const client = appClient(
    { pubkey: "agent", query } as unknown as AgentHandle,
    {
      read: vi.fn(),
      signal: controller.signal,
      memories: async () => ({ entries: [], partial: false }),
    },
  );
  const result = client.query([{ kinds: [9] }]);
  expect(query).toHaveBeenCalledOnce();
  controller.abort(new Error("Owning turn ended"));
  release();
  await expect(result).rejects.toThrow("Owning turn ended");
});

it("binds current audience decisions to the connected community and fences turn cancellation", async () => {
  const community = "11111111-1111-4111-8111-111111111111";
  const destination = "22222222-2222-4222-8222-222222222222";
  const source = "33333333-3333-4333-8333-333333333333";
  const pubkey = "a".repeat(64);
  const response = {
    audience_authority: 1,
    complete: true,
    community_id: community,
    pubkey,
    destination,
    sources: [{ id: source, allowed: true }],
  };
  const authority = vi.fn(async () => response);
  const controller = new AbortController();
  const client = appClient(
    { pubkey, audienceAuthority: authority } as unknown as AgentHandle,
    {
      read: vi.fn(),
      memories: async () => ({ entries: [], partial: false }),
      audienceAuthorityCommunity: community,
      signal: controller.signal,
    },
  );
  expect(await client.authorizeAudience?.(destination, [source])).toEqual(
    new Set([source]),
  );
  expect(authority).toHaveBeenCalledWith(destination, [source]);
  authority.mockImplementationOnce(async () => {
    controller.abort();
    return response;
  });
  await expect(
    client.authorizeAudience?.(destination, [source]),
  ).rejects.toThrow();
});

it("refuses creation after the calling turn ends and surfaces native failures", async () => {
  const createAgent = vi.fn(async () => {
    throw new Error("Native creation failed");
  });
  const controller = new AbortController();
  const client = appClient({ createAgent } as unknown as AgentHandle, {
    read: vi.fn(),
    signal: controller.signal,
    memories: async () => ({ entries: [], partial: false }),
  });
  await expect(
    client.createAgent?.({ type: "codex/codex", name: "Child" }),
  ).rejects.toThrow("Native creation failed");
  controller.abort(new Error("Turn ended"));
  await expect(
    client.createAgent?.({ type: "codex/codex", name: "Child" }),
  ).rejects.toThrow("Turn ended");
  expect(createAgent).toHaveBeenCalledOnce();
});
