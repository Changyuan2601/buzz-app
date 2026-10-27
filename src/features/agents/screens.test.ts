import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { communityDestination } from "../communities/destination";
import type { RelayData } from "../relay/service";
import { connectAgents, serveAgents } from "./port";
import { ScreensAgents } from "./screens";
import type { Agents, AgentsSnapshot } from "./service";
import type { ToolOwner } from "./tool-port";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});
const key = "a".repeat(64);
const snapshot: AgentsSnapshot = {
  status: "ready",
  classifier: "available",
  classifierKey: "saved",
  agents: [],
  running: [{ key, relay: "wss://alpha.example" }] as never,
  interrupted: [],
  teams: [],
};
function setup() {
  const agents = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    types: () => [],
    memberships: () => [],
    joinable: () => [],
    interruptible: () => false,
    creationRequests: () => [],
    updateRequests: () => [],
  } as unknown as Agents;
  const added = new Map<string, ToolOwner>();
  const { port1, port2 } = new MessageChannel();
  const stop = serveAgents(agents, port1, {
    addTool: (tool, owner) => {
      added.set(tool.name, owner);
      return () => added.delete(tool.name);
    },
  });
  const client = connectAgents(port2);
  const ctx = new Context();
  const community = {} as RelayData;
  const open = vi.fn(() => community);
  new ScreensAgents(ctx, client, open);
  stops.push(
    stop,
    () => client.close(),
    () => ctx.fiber.dispose(),
  );
  return { ctx, client, added, open, community };
}
const tool: AddedTool = {
  name: "files_copy",
  description: "Copy a file.",
  inputSchema: { type: "object" },
  call: async () => "done",
};

it("lists a UI entry's tool under its plugin until the plugin stops", async () => {
  const { ctx, added } = setup();
  const owner = Object.freeze({ id: "example", revision: "1" });
  const plugin = ctx.extend({ pluginOwner: owner }).plugin({
    inject: ["agents"],
    apply: (scope: Context) => scope.agents.addTool(tool),
  });
  await vi.waitFor(() => expect(added.get("files_copy")).toEqual(owner));
  await plugin.dispose();
  await vi.waitFor(() => expect(added.size).toBe(0));
});

it("connects a running agent's community from this page, and refuses what only running agents use", async () => {
  const { ctx, client, open, community } = setup();
  await vi.waitFor(() => expect(client.snapshot().running).toHaveLength(1));
  expect(ctx.agents.relay(key)).toBe(community);
  expect(open).toHaveBeenCalledWith(
    communityDestination("wss://alpha.example").url,
  );
  expect(ctx.agents.relay("b".repeat(64))).toBeUndefined();
  expect(() =>
    ctx.agents.wake(key, { channelId: "c", text: "t" } as never),
  ).toThrow(/agent entry/);
  expect(() => ctx.agents.storage).toThrow(/agent entry/);
  // Outside a plugin, nothing names whose tool it would be.
  expect(() => ctx.agents.addTool(tool)).toThrow(/Only a plugin/);
});
