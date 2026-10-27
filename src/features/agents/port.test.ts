import { afterEach, expect, it, vi } from "vitest";
import type { BuzzClient } from "../../buzz-mcp/client";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { Events, Frame } from "./event-port";
import { eventPort } from "./event-port";
import { keyedRead } from "./handles";
import { connectAgents, serveAgents, shared } from "./port";
import type {
  Agents,
  AgentsSnapshot,
  AgentType,
  RemoteAgentType,
} from "./service";

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

/** Tauri events between webviews, each delivered later and as JSON. */
function jsonEvents(): Events {
  const handlers = new Set<(event: { payload: Frame }) => void>();
  return {
    emitTo: async (_webview, _event, frame) => {
      const payload = JSON.parse(JSON.stringify(frame)) as Frame;
      setTimeout(() => {
        for (const handler of [...handlers]) handler({ payload });
      });
    },
    listen: async (_event, handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

it("serves screens in another webview, whichever page loads first", async () => {
  const events = jsonEvents();
  const agents = fakeAgents();
  const client = connectAgents(eventPort("main", "agents", events));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stop = serveAgents(
    agents as unknown as Agents,
    eventPort("agents", "main", events),
  );
  stops.push(() => {
    client.close();
    stop();
  });
  await vi.waitFor(() => expect(client.snapshot().status).toBe("ready"));
  await expect(
    client.saveTeam({ name: "Crew", instructions: "", members: [] }),
  ).resolves.toMatchObject({ name: "Crew" });
  expect(client.snapshot().teams.map((team) => team.name)).toEqual(["Crew"]);
  // The screens' page reloads; the service has nothing new to push.
  client.close();
  const reloaded = connectAgents(eventPort("main", "agents", events));
  stops.push(() => reloaded.close());
  await vi.waitFor(() =>
    expect(reloaded.snapshot().teams.map((team) => team.name)).toEqual([
      "Crew",
    ]),
  );
});

it("carries a tool's bytes as JSON, and lists the tools again with a reloaded service", async () => {
  const events = jsonEvents();
  const agents = fakeAgents() as unknown as Agents;
  const added = new Map<string, AddedTool>();
  const addTool = (tool: AddedTool) => {
    added.set(tool.name, tool);
    return () => added.delete(tool.name);
  };
  const client = connectAgents(eventPort("main", "agents", events));
  client.addTool(
    {
      name: "files_copy",
      description: "Copy a file.",
      inputSchema: { type: "object" },
      call: async (agent) => {
        const data = await agent.read("/tmp/a");
        return (await agent.upload(data, "text/plain")).url;
      },
    },
    { id: "example", revision: "1" },
  );
  const first = serveAgents(agents, eventPort("agents", "main", events), {
    addTool,
  });
  await vi.waitFor(() => expect(added.has("files_copy")).toBe(true));
  const upload = vi.fn(async (data: Uint8Array) => ({
    url: `https://media.example/${data.length}`,
  }));
  const agent = {
    pubkey: "p",
    key: "k",
    read: async () => new Uint8Array([1, 2, 3]),
    upload,
  } as unknown as BuzzClient;
  await expect(added.get("files_copy")?.call(agent, {}, {})).resolves.toBe(
    "https://media.example/3",
  );
  expect(upload).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "text/plain");
  // The agents page reloads: its tools go with it, and come back listed.
  first();
  expect(added.size).toBe(0);
  const second = serveAgents(agents, eventPort("agents", "main", events), {
    addTool,
  });
  stops.push(() => {
    client.close();
    second();
  });
  await vi.waitFor(() => expect(added.has("files_copy")).toBe(true));
});

it("ends a tool's call when the screens' page that answers it reloads", async () => {
  const events = jsonEvents();
  const added = new Map<string, AddedTool>();
  const stop = serveAgents(
    fakeAgents() as unknown as Agents,
    eventPort("agents", "main", events),
    {
      addTool: (tool) => {
        added.set(tool.name, tool);
        return () => added.delete(tool.name);
      },
    },
  );
  const tool = {
    name: "notes_wait",
    description: "Wait.",
    inputSchema: { type: "object" },
    call: () => new Promise<string>(() => {}),
  } as const;
  const owner = { id: "example", revision: "1" };
  const before = connectAgents(eventPort("main", "agents", events));
  before.addTool(tool, owner);
  await vi.waitFor(() => expect(added.has("notes_wait")).toBe(true));
  const waiting = added
    .get("notes_wait")
    ?.call({ pubkey: "p", key: "k" } as unknown as BuzzClient, {}, {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  before.close();
  const after = connectAgents(eventPort("main", "agents", events));
  after.addTool(tool, owner);
  stops.push(() => {
    after.close();
    stop();
  });
  await expect(waiting).rejects.toThrow(/reloaded/);
});

const hostedType = (remote: Partial<RemoteAgentType> = {}): AgentType => ({
  id: "cloud",
  title: "Cloud",
  defaults: () => ({ config: { model: "m" } }),
  remote: {
    provision: async () => ({ pubkey: "p" }),
    activate: async () => {},
    profile: async () => {},
    remove: async () => {},
    ...remote,
  },
});
function hostedTypes() {
  const added = new Map<string, AgentType>();
  return {
    added,
    register: (type: AgentType, owner: { id: string }) => {
      const key = `${owner.id}/${type.id}`;
      added.set(key, type);
      return () => added.delete(key);
    },
  };
}
const owner = { id: "example", revision: "1" };

it("carries a hosted type's step and its abort, and refuses a type that runs its agents in the screens' page", async () => {
  const events = jsonEvents();
  const { added, register } = hostedTypes();
  const stop = serveAgents(
    fakeAgents() as unknown as Agents,
    eventPort("agents", "main", events),
    { register },
  );
  const client = connectAgents(eventPort("main", "agents", events));
  stops.push(() => {
    client.close();
    stop();
  });
  let aborted: AbortSignal | undefined;
  client.register(
    hostedType({
      interrupt: ({ signal }) =>
        new Promise<boolean>((_, reject) => {
          aborted = signal;
          signal.addEventListener("abort", () =>
            reject(new Error("Stopped waiting")),
          );
        }),
    }),
    owner,
  );
  await vi.waitFor(() => expect(added.has("example/cloud")).toBe(true));
  const stand = added.get("example/cloud");
  expect(stand?.defaults()).toEqual({ config: { model: "m" } });
  await expect(
    stand?.remote?.provision({
      name: "Sky",
      community: "wss://c",
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({ pubkey: "p" });
  const controller = new AbortController();
  const stopping = stand?.remote?.interrupt?.({
    pubkey: "p",
    community: "wss://c",
    channelId: "c",
    threadRootId: "r",
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(aborted).toBeDefined());
  controller.abort();
  await expect(stopping).rejects.toThrow("Stopped waiting");
  expect(aborted?.aborted).toBe(true);
  // A type that runs its agents here has nowhere to run them.
  expect(() =>
    client.register(
      { id: "echo", title: "Echo", defaults: () => ({ config: {} }) },
      owner,
    ),
  ).toThrow(/needs an agent entry/);
  expect(() =>
    client.register(
      { ...hostedType(), id: "busy", usage: async () => [] },
      owner,
    ),
  ).toThrow(/usage, which only an agent entry/);
});

it("ends a hosted type's step when the screens' page reloads, and lists it again with a reloaded service", async () => {
  const events = jsonEvents();
  const { added, register } = hostedTypes();
  const first = serveAgents(
    fakeAgents() as unknown as Agents,
    eventPort("agents", "main", events),
    { register },
  );
  const type = hostedType({ remove: () => new Promise<void>(() => {}) });
  const before = connectAgents(eventPort("main", "agents", events));
  before.register(type, owner);
  await vi.waitFor(() => expect(added.has("example/cloud")).toBe(true));
  const removing = added.get("example/cloud")?.remote?.remove({
    pubkey: "p",
    community: "wss://c",
    signal: new AbortController().signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  before.close();
  const after = connectAgents(eventPort("main", "agents", events));
  after.register(type, owner);
  await expect(removing).rejects.toThrow(/reloaded/);
  // The agents page reloads: its stand-in goes with it, and comes back.
  first();
  expect(added.size).toBe(0);
  const second = serveAgents(
    fakeAgents() as unknown as Agents,
    eventPort("agents", "main", events),
    { register },
  );
  stops.push(() => {
    after.close();
    second();
  });
  await vi.waitFor(() => expect(added.has("example/cloud")).toBe(true));
});

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
