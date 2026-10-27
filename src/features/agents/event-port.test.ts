import { expect, it } from "vitest";
import { eventPort, type Events, type Frame } from "./event-port";

/** Tauri events between webviews, delivered when the test says, each batch
 * in reverse, and as JSON. */
function bus() {
  const handlers = new Set<(event: { payload: Frame }) => void>();
  let queue: Frame[] = [];
  const events: Events = {
    emitTo: async (_webview, _event, frame) => {
      queue.push(JSON.parse(JSON.stringify(frame)) as Frame);
    },
    listen: async (_event, handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  return {
    events,
    /** Delivers what was sent, then what that sent, until nothing is. */
    async settle() {
      for (let round = 0; round < 20; round += 1) {
        for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
        const batch = queue;
        queue = [];
        if (!batch.length) continue;
        for (const frame of batch.reverse())
          for (const handler of [...handlers]) handler({ payload: frame });
      }
    },
  };
}

function received(port: ReturnType<typeof eventPort>) {
  const messages: unknown[] = [];
  port.onmessage = ({ data }) => messages.push(data);
  return messages;
}

it("delivers each message once, in the order sent, though frames arrive out of order", async () => {
  const { events, settle } = bus();
  const agents = eventPort("agents", "main", events);
  const main = eventPort("main", "agents", events);
  const heard = received(main);
  await settle();
  for (const n of [1, 2, 3]) agents.postMessage({ n });
  await settle();
  expect(heard).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
});

it("holds what a page sends until the other page is up", async () => {
  const { events, settle } = bus();
  const main = eventPort("main", "agents", events);
  main.postMessage("early");
  await settle();
  const agents = eventPort("agents", "main", events);
  const heard = received(agents);
  await settle();
  expect(heard).toEqual(["early"]);
});

it("talks to a reloaded page afresh, and drops the old page's late frames", async () => {
  const { events, settle } = bus();
  const agents = eventPort("agents", "main", events);
  const heardByAgents = received(agents);
  const before = eventPort("main", "agents", events);
  await settle();
  // The old page's last message is still on its way when the page reloads.
  before.postMessage("stale");
  before.close();
  const after = eventPort("main", "agents", events);
  const heardByMain = received(after);
  await settle();
  after.postMessage("fresh");
  agents.postMessage("hello again");
  await settle();
  expect(heardByAgents).toEqual(["fresh"]);
  expect(heardByMain).toEqual(["hello again"]);
});

it("ignores frames for another webview", async () => {
  const { events, settle } = bus();
  const agents = eventPort("agents", "main", events);
  const main = eventPort("main", "agents", events);
  const huddle = eventPort("huddle", "agents", events);
  const heard = received(huddle);
  await settle();
  agents.postMessage("for main");
  await settle();
  expect(heard).toEqual([]);
  main.close();
});
