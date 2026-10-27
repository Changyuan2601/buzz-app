import { afterEach, expect, it, vi } from "vitest";
import { keyedRead } from "./handles";
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
    types: () => [] as unknown[],
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

/** A type as the service has it, with stores that change on their own. */
function fakeType() {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let readiness: "checking" | "ready" | "attention" = "checking";
  let installed = false;
  const sessions: Record<string, { key: string; busy: boolean }[]> = {};
  const aborted = vi.fn();
  const type = {
    key: "example/shown",
    pluginId: "example",
    revision: "1",
    id: "shown",
    title: "Shown",
    defaults: () => ({ config: { model: "" } }),
    models: vi.fn(async (agent: { key: string }) => ({
      current: `${agent.key}-model`,
      models: [],
    })),
    provider: {
      snapshot: () => ({ readiness }),
      subscribe,
      check: vi.fn(async () => {
        readiness = "ready";
        notify();
      }),
      get attentionAction() {
        return readiness === "attention" ? () => {} : undefined;
      },
    },
    expose: {
      setup: {
        snapshot: () => ({ installed }),
        subscribe,
        install: vi.fn(async () => {
          installed = true;
          notify();
          return "installed";
        }),
      },
      runtime: {
        sessions: keyedRead((key) => sessions[key] ?? [], subscribe, []),
        transcript: (_key: string, signal: AbortSignal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              aborted();
              reject(new Error("stopped"));
            });
          }),
      },
    },
  };
  return {
    type,
    aborted,
    notify,
    setSessions(key: string, value: { key: string; busy: boolean }[]) {
      sessions[key] = value;
      notify();
    },
    setReadiness(next: typeof readiness) {
      readiness = next;
      notify();
    },
  };
}

type Shown = {
  setup: {
    snapshot(): { installed: boolean };
    subscribe(listener: () => void): () => void;
    install(): Promise<string>;
  };
  runtime: {
    sessions: {
      read(key: string): readonly { key: string; busy: boolean }[];
    };
    transcript(key: string, signal: AbortSignal): Promise<unknown>;
  };
};

it("carries a type and what it exposes to the screens' page, which presents it", async () => {
  const fake = fakeType();
  const agents = fakeAgents();
  agents.types = () => [fake.type];
  const client = connected(agents);
  const Tab = () => null;
  let exposed: Shown | undefined;
  client.present("example/shown", (handles) => {
    exposed = handles as Shown;
    return { tabs: [{ id: "t", title: "T", component: Tab }] };
  });
  await vi.waitFor(() => expect(client.types()).toHaveLength(1));
  const [type] = client.types();
  expect(type).toMatchObject({
    key: "example/shown",
    title: "Shown",
    tabs: [{ id: "t", component: Tab }],
  });
  expect(type?.defaults()).toEqual({ config: { model: "" } });
  expect(type?.remote).toBeUndefined();
  // A store's snapshot is read synchronously, and kept while it is the same.
  expect(exposed?.setup.snapshot()).toEqual({ installed: false });
  expect(type?.provider?.snapshot()).toEqual({ readiness: "checking" });
  const snapshot = exposed?.setup.snapshot();
  fake.notify();
  await Promise.resolve();
  expect(exposed?.setup.snapshot()).toBe(snapshot);
  // A call answers after the change it made.
  await expect(exposed?.setup.install()).resolves.toBe("installed");
  expect(exposed?.setup.snapshot()).toEqual({ installed: true });
  await type?.provider?.check();
  expect(type?.provider?.snapshot()).toEqual({ readiness: "ready" });
  expect(type?.provider?.attentionAction).toBeUndefined();
  fake.setReadiness("attention");
  await vi.waitFor(() =>
    expect(type?.provider?.attentionAction).toBeTypeOf("function"),
  );
  await expect(
    type?.models?.({ key: "a" } as Parameters<
      NonNullable<NonNullable<typeof type>["models"]>
    >[0]),
  ).resolves.toEqual({ current: "a-model", models: [] });
  // The screens see one stable type while its stores change.
  expect(client.types()[0]).toBe(type);
});

it("reads a key as empty until the service pushes it, then follows it", async () => {
  const fake = fakeType();
  fake.setSessions("a", [{ key: "one", busy: true }]);
  const agents = fakeAgents();
  agents.types = () => [fake.type];
  const client = connected(agents);
  let exposed: Shown | undefined;
  client.present("example/shown", (handles) => {
    exposed = handles as Shown;
    return {};
  });
  await vi.waitFor(() => expect(client.types()).toHaveLength(1));
  client.types();
  expect(exposed?.runtime.sessions.read("a")).toEqual([]);
  await vi.waitFor(() =>
    expect(exposed?.runtime.sessions.read("a")).toEqual([
      { key: "one", busy: true },
    ]),
  );
  const first = exposed?.runtime.sessions.read("a");
  fake.setSessions("a", [{ key: "one", busy: false }]);
  await vi.waitFor(() =>
    expect(exposed?.runtime.sessions.read("a")).toEqual([
      { key: "one", busy: false },
    ]),
  );
  expect(exposed?.runtime.sessions.read("a")).not.toBe(first);
});

it("stops an exposed call in the service when the screen aborts it", async () => {
  const fake = fakeType();
  const agents = fakeAgents();
  agents.types = () => [fake.type];
  const client = connected(agents);
  let exposed: Shown | undefined;
  client.present("example/shown", (handles) => {
    exposed = handles as Shown;
    return {};
  });
  await vi.waitFor(() => expect(client.types()).toHaveLength(1));
  client.types();
  const abort = new AbortController();
  const reading = exposed?.runtime.transcript("a", abort.signal);
  abort.abort();
  await expect(reading).rejects.toThrow("stopped");
  expect(fake.aborted).toHaveBeenCalledOnce();
});

it("does not show a type whose handles cannot cross", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  class Setup {
    check() {}
  }
  const agents = fakeAgents();
  agents.types = () => [
    {
      key: "example/leaky",
      pluginId: "example",
      revision: "1",
      id: "leaky",
      title: "Leaky",
      defaults: () => ({ config: {} }),
      expose: { setup: new Setup() },
    },
  ];
  const client = connected(agents);
  const shown = vi.fn(() => ({ tabs: [] }));
  client.present("example/leaky", shown);
  await vi.waitFor(() => expect(client.types()).toHaveLength(1));
  expect(client.types()[0]).toMatchObject({ title: "Leaky" });
  expect(client.types()[0]?.tabs).toBeUndefined();
  expect(shown).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});
