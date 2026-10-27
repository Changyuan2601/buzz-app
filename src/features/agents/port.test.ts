import { afterEach, expect, it, vi } from "vitest";
import { connectAgents, serveAgents, shared } from "./port";
import type { Agents, AgentsSnapshot } from "./service";

it("keeps each part of the prior value that the next one equals", () => {
  const a = Object.freeze({ key: "a", name: "A", config: { x: 1 } });
  const b = Object.freeze({ key: "b", name: "B", config: { x: 2 } });
  const prior = Object.freeze({
    agents: Object.freeze([a, b]),
    status: "ready",
  });
  // As a structured clone arrives: equal, but none of it the same object.
  const same = structuredClone(prior);
  expect(shared(prior, same)).toBe(prior);
  // b changed and moved first; a is still a.
  const next = shared(prior, {
    agents: [{ key: "b", name: "Bee", config: { x: 2 } }, structuredClone(a)],
    status: "ready",
  });
  expect(next).not.toBe(prior);
  expect(next.agents[1]).toBe(a);
  expect(next.agents[0]).not.toBe(b);
  expect(next.agents[0]?.config).toBe(b.config);
  expect(Object.isFrozen(next.agents[0])).toBe(true);
  expect(shared(prior, { ...same, error: "x" })).not.toBe(prior);
  expect(shared({ status: "ready", error: "x" }, { status: "ready" })).toEqual({
    status: "ready",
  });
});

const snapshot = (patch: Partial<AgentsSnapshot> = {}): AgentsSnapshot => ({
  status: "ready",
  classifier: "available",
  classifierKey: "saved",
  agents: [],
  running: [],
  interrupted: [],
  teams: [],
  ...patch,
});
function fakeAgents() {
  let state = snapshot();
  const listeners = new Set<() => void>();
  const agents = {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    memberships: () => [],
    joinable: () => [],
    interruptible: () => false,
    creationRequests: () => [],
    updateRequests: () => [],
    resumeInterrupted: vi.fn(),
    saveTeam: vi.fn(async (team: { name: string }) => {
      state = snapshot({
        teams: [{ id: "t", name: team.name, instructions: "", members: [] }],
      });
      for (const listener of listeners) listener();
      return state.teams[0];
    }),
    removeTeam: vi.fn(async () => {
      throw new Error("No such team");
    }),
  };
  return agents;
}
let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});
function connected(agents: ReturnType<typeof fakeAgents>) {
  const { port1, port2 } = new MessageChannel();
  const stop = serveAgents(agents as unknown as Agents, port1);
  const client = connectAgents(port2);
  stops.push(() => {
    client.close();
    stop();
  });
  return client;
}

it("reads as loading until the service's first push, then as the service", async () => {
  const client = connected(fakeAgents());
  expect(client.snapshot().status).toBe("loading");
  const changed = vi.fn();
  client.subscribe(changed);
  await vi.waitFor(() => expect(client.snapshot().status).toBe("ready"));
  expect(changed).toHaveBeenCalledOnce();
  expect(client.classifier()).toBe("available");
});

it("answers a call after the state it changed, and carries a refusal", async () => {
  const agents = fakeAgents();
  const client = connected(agents);
  const team = await client.saveTeam({
    name: "Crew",
    instructions: "",
    members: [],
  });
  expect(team).toMatchObject({ id: "t", name: "Crew" });
  expect(client.snapshot().teams.map((item) => item.name)).toEqual(["Crew"]);
  await expect(client.removeTeam("t")).rejects.toThrow("No such team");
});

it("sends a handler's call without the click event", async () => {
  const agents = fakeAgents();
  const client = connected(agents);
  // As `onClick={agents.resumeInterrupted}` calls it.
  (client.resumeInterrupted as (event: Event) => void)(new Event("click"));
  await vi.waitFor(() => expect(agents.resumeInterrupted).toHaveBeenCalled());
  expect(agents.resumeInterrupted).toHaveBeenCalledWith();
});

it("refuses calls once closed, and fails those still waiting", async () => {
  const agents = fakeAgents();
  agents.removeTeam.mockReturnValueOnce(new Promise(() => {}));
  const client = connected(agents);
  const waiting = client.removeTeam("t");
  client.close();
  await expect(waiting).rejects.toThrow("closed");
  await expect(client.removeTeam("t")).rejects.toThrow("closed");
});
