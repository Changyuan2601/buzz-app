// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_INSTRUCTIONS_LENGTH } from "../builderlab/agents/client";
import { bestieInstructions, promptVersion } from "./prompt";
import { BUILDERLAB_TYPE } from "./setup";
import { bestieFixture, cleanups, HOME, MODEL } from "./testing";

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  // Native identity signs the owner's attestation on desktop.
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  // Web Locks grant each name to one holder at a time, in request order.
  const queues = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (
        name: string,
        options: { signal: AbortSignal },
        work: () => Promise<void>,
      ) => {
        const granted = (queues.get(name) ?? Promise.resolve()).then(() => {
          options.signal.throwIfAborted();
          return work();
        });
        queues.set(
          name,
          granted.catch(() => {}),
        );
        return granted;
      },
    },
  });
  let next = 0;
  const randomUUID = crypto.randomUUID.bind(crypto);
  // The first UUID is Bestie's home; the rest stay random.
  vi.spyOn(crypto, "randomUUID").mockImplementation(() =>
    next++ === 0 ? HOME : randomUUID(),
  );
  // Builderlab's profile() is unsupported until cash-server #136267.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  localStorage.clear();
  native.invoke.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(navigator, "locks");
  Reflect.deleteProperty(navigator, "platform");
});

const kinds = (h: Awaited<ReturnType<typeof bestieFixture>>, kind: number) =>
  h.events.filter((event) => event.kind === kind);
/** Check-in as the ready page shows it, once the relay has been read. */
const checkIn = async (
  h: Awaited<ReturnType<typeof bestieFixture>>,
  bestie = h.bestie,
) => {
  await vi.waitFor(() =>
    expect(bestie.snapshot().checkIn?.pending).toBe(false),
  );
  return bestie.snapshot().checkIn;
};

it("keeps the kernel within Builderlab's instruction limit", () => {
  const kernel = bestieInstructions("ab".repeat(32), HOME);
  expect(kernel.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_LENGTH);
  expect(kernel).toContain(HOME);
  expect(promptVersion(kernel)).toBe(promptVersion(kernel));
  expect(promptVersion(kernel)).not.toBe(promptVersion(`${kernel} `));
});

it("creates hosted Bestie through Agents, then instructs, homes and introduces it", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    record: { agent: h.agent, channelId: HOME, complete: true },
  });
  // Agents made it at Builderlab and listed it as hosted for every device.
  const registration = h.requests("register-agent");
  expect(registration).toHaveLength(1);
  const [, registerInput] = registration[0] ?? [];
  expect(
    JSON.parse((registerInput as { request: { body: string } }).request.body)
      .agent_type,
  ).toBe("AGENT_TYPE_BESTIE");
  expect(h.agents.find(h.agent)).toMatchObject({
    name: "Bestie",
    type: BUILDERLAB_TYPE,
    place: "hosted",
  });
  expect(h.agents.find(h.agent)?.unfinished).toBeUndefined();
  const listing = kinds(h, 30177);
  expect(listing).toHaveLength(1);
  expect(listing[0]?.tags).toContainEqual(["runtime", BUILDERLAB_TYPE]);
  expect(h.agents.find(h.agent)?.picture).toMatch(/^https:/);
  // The picture reaches only the listing until Beekeeper can republish profiles.
  expect(console.warn).toHaveBeenCalledWith(
    "Agent Bestie picture was not published",
    expect.any(Error),
  );
  expect(h.rows[0]?.agent_instructions).toBe(
    bestieInstructions(h.viewer, HOME),
  );
  // The private home, with only the owner and Bestie.
  const creation = kinds(h, 9007);
  expect(creation).toHaveLength(1);
  expect(creation[0]?.tags).toContainEqual(["h", HOME]);
  expect(h.channels.get(HOME)).toEqual({
    members: [h.viewer, h.agent],
    visibility: "private",
  });
  const intro = kinds(h, 9);
  expect(intro).toHaveLength(1);
  expect(intro[0]?.tags).toContainEqual(["h", HOME]);
  expect(intro[0]?.tags).toContainEqual(["p", h.agent]);
  // Instructions were set before the intro could wake Bestie.
  const order =
    h.publish.mock.invocationCallOrder[
      h.publish.mock.calls.findIndex(([event]) => event.kind === 9)
    ];
  const instructed =
    native.invoke.mock.invocationCallOrder[
      native.invoke.mock.calls.findIndex(([, input]) =>
        String(input?.request?.url).endsWith("/update-agent"),
      )
    ];
  expect(instructed).toBeLessThan(order ?? 0);
  // Beekeeper signs Bestie's check-in as Bestie; the owner signs no workflow.
  expect(kinds(h, 30620)).toHaveLength(0);
  const enabled = h.requests("enable-bestie");
  expect(enabled).toHaveLength(1);
  const [, input] = enabled[0] ?? [];
  expect(
    JSON.parse((input as { request: { body: string } }).request.body),
  ).toEqual({
    agent_id: h.rows[0]?.agent_id,
    community_url: "wss://community.example",
    channel_id: HOME,
  });
  // The switch shows what the relay holds: Bestie's own heartbeat.
  expect(h.heartbeats.map((event) => event.pubkey)).toEqual([h.agent]);
  expect(await checkIn(h)).toEqual({ on: true, pending: false });
  expect(JSON.stringify(localStorage)).not.toContain("checkIn");
});

it("finishes setup when Builderlab can't turn on check-in, and retries by turning it on again", async () => {
  const h = await bestieFixture(native.invoke);
  h.reply("enable-bestie", 200, {
    status: "failed",
    error_code: "rejected",
    error_message: "The relay rejected check-in: forbidden",
  });
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    record: { complete: true },
  });
  expect(await checkIn(h)).toEqual({
    on: false,
    pending: false,
    problem: "The relay rejected check-in: forbidden",
  });
  // Setup only tries once; the switch owns the retry from here.
  await h.bestie.setup();
  expect(h.requests("enable-bestie")).toHaveLength(1);
  await h.bestie.setCheckIn(true);
  expect(h.requests("enable-bestie")).toHaveLength(2);
  expect(h.bestie.snapshot().checkIn).toEqual({ on: true, pending: false });
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(kinds(h, 9)).toHaveLength(1);
});

it("reopens a finished setup after restart without another agent, channel or intro", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  const published = h.events.length;
  await h.restart();
  await h.bestie.setup();
  expect(h.bestie.snapshot().message).toBe("Your Bestie is set up.");
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.requests("update-agent")).toHaveLength(1);
  expect(h.requests("enable-bestie")).toHaveLength(1);
  expect(h.events).toHaveLength(published);
});

it("offers to update a set-up Bestie whose instructions changed, and changes nothing else", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  const published = h.events.length;
  // As if prompt.ts changed after this Bestie was set up.
  const key = Object.keys(localStorage).find((name) =>
    name.startsWith("buzz.remote-bestie.v2:"),
  );
  if (!key) throw new Error("Missing Bestie record");
  localStorage.setItem(
    key,
    JSON.stringify({
      ...JSON.parse(localStorage.getItem(key) ?? "{}"),
      promptVersion: "remote-bestie-1",
    }),
  );
  await h.restart();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    instructionsChanged: true,
  });
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(h.bestie.snapshot().instructionsChanged).toBeFalsy();
  const updates = h.requests("update-agent");
  expect(updates).toHaveLength(2);
  const last = updates.at(-1)?.[1] as { request: { body: string } };
  expect(JSON.parse(last.request.body).agent_instructions).toBe(
    bestieInstructions(h.viewer, HOME),
  );
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.events).toHaveLength(published);
});

it("finishes an unfinished hosted Bestie on retry instead of registering another", async () => {
  const h = await bestieFixture(native.invoke);
  h.reply("attest-agent", 500, {});
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message: "Builderlab request failed (HTTP 500).",
  });
  expect(h.agents.find(h.agent)?.unfinished).toBe(true);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.requests("attest-agent")).toHaveLength(2);
  expect(h.agents.find(h.agent)?.unfinished).toBeUndefined();
  expect(kinds(h, 9007)[0]?.tags).toContainEqual(["h", HOME]);
});

it("says why Builderlab refused to set up Bestie", async () => {
  const h = await bestieFixture(native.invoke);
  h.reply("attest-agent", 200, {
    status: "ATTEST_AGENT_STATUS_NO_OWNER_IDENTITY_BOUND",
  });
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message: expect.stringContaining(
      "Agent setup was not confirmed (ATTEST_AGENT_STATUS_NO_OWNER_IDENTITY_BOUND)",
    ),
  });
  expect(h.agents.find(h.agent)?.unfinished).toBe(true);
});

it("offers a new Bestie when the saved one left this Builderlab account", async () => {
  const h = await bestieFixture(native.invoke);
  h.reply("attest-agent", 500, {});
  await h.bestie.setup();
  h.reply("attest-agent", 500, {});
  await h.bestie.setup();
  expect(h.agents.find(h.agent)?.unfinished).toBe(true);
  // Revoked outside this app, e.g. from another device.
  for (const row of h.rows) row.status = 3;
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message: expect.stringContaining("isn't in this Builderlab account"),
    canCreateNew: true,
  });
  expect(h.requests("register-agent")).toHaveLength(1);
  // Agents would resume the unfinished one, so the owner deletes it first.
  await h.bestie.setup(undefined, { createNew: true });
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message: expect.stringContaining("Delete it in Agents"),
  });
  expect(h.requests("register-agent")).toHaveLength(1);
  await h.agents.remove(h.agent);
  await h.bestie.setup(undefined, { createNew: true });
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    message: "Your Bestie is set up.",
  });
  expect(h.requests("register-agent")).toHaveLength(2);
  expect(h.bestie.snapshot().record?.agent).not.toBe(h.agent);
});

it("explains a canceled Builderlab sign-in and creates nothing until retried", async () => {
  const h = await bestieFixture(native.invoke);
  h.cancelNextSignIn();
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("error");
  expect(h.bestie.snapshot().message).toMatch(
    /^Sign in to Builderlab to set up Bestie\./,
  );
  expect(h.requests("register-agent")).toHaveLength(0);
  expect(h.events).toHaveLength(0);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("ready");
});

it("explains a refused account (screening) and keeps the reserved home for the retry", async () => {
  const h = await bestieFixture(native.invoke);
  h.reply("register-agent", 403, { error: "forbidden" });
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    record: { channelId: HOME },
  });
  expect(h.bestie.snapshot().message).toContain("finish your account details");
  expect(h.agents.snapshot().agents).toHaveLength(0);
  expect(h.events).toHaveLength(0);
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    record: { channelId: HOME },
  });
});

it("lets the owner choose among several hosted Besties without registering another", async () => {
  const h = await bestieFixture(native.invoke);
  for (let index = 0; index < 2; index++)
    await h.agents.create({
      type: BUILDERLAB_TYPE,
      name: "Bestie",
      config: { instructions: "", ...MODEL, subject: "owner" },
    });
  const [, second] = h.rows;
  if (!second) throw new Error("Missing second Bestie");
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("choose-agent");
  expect(h.bestie.snapshot().candidates).toHaveLength(2);
  // Agent changes do not drop the pending choice.
  await h.agents.refresh();
  expect(h.bestie.snapshot().status).toBe("choose-agent");
  await h.bestie.setup(second.agent_pubkey);
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    record: { agent: second.agent_pubkey },
  });
  expect(h.requests("register-agent")).toHaveLength(2);
  const home = h.bestie.snapshot().record?.channelId ?? "";
  expect(second.agent_instructions).toBe(bestieInstructions(h.viewer, home));
  expect(h.rows[0]?.agent_instructions).toBe("");
});

it("refuses to introduce Bestie into a home that has other members", async () => {
  const h = await bestieFixture(native.invoke);
  h.failPublication(9);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("error");
  h.addMember("12".repeat(32));
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message:
      "Bestie's channel must be private and contain only you and Bestie. Review its members before continuing.",
  });
});

it("delivers a lost intro once after restart", async () => {
  const h = await bestieFixture(native.invoke);
  h.failPublication(9);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("error");
  await h.restart();
  await h.bestie.setup();
  expect(h.bestie.snapshot().message).toBe("Your Bestie is set up.");
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(kinds(h, 9)).toHaveLength(1);
  expect(h.sign.mock.calls.filter(([event]) => event.kind === 9)).toHaveLength(
    1,
  );
});

it("resumes an unlisted Bestie the account already has instead of registering a second one", async () => {
  const h = await bestieFixture(native.invoke);
  h.rows.push({
    key: "elsewhere",
    agent_id: "elsewhere",
    agent_name: "Bestie",
    agent_pubkey: "34".repeat(32),
    status: 2,
    agent_type: 1,
  });
  await h.bestie.setup();
  // Builderlab refused a second Bestie; setup resumed the existing one
  // instead of offering to create a new one, which could only be refused
  // again now that the server allows only one live Bestie per owner.
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    message: "Your Bestie is set up.",
    record: { agent: "34".repeat(32), complete: true },
  });
  expect(h.bestie.snapshot().canCreateNew).toBeFalsy();
  expect(
    h.rows.find((row) => row.agent_id === "elsewhere")?.agent_instructions,
  ).toBe(bestieInstructions(h.viewer, HOME));
});

it("explains an unfinished Bestie found elsewhere in the account without offering a new one", async () => {
  const h = await bestieFixture(native.invoke);
  h.rows.push({
    key: "elsewhere",
    agent_id: "elsewhere",
    agent_name: "Bestie",
    agent_pubkey: "34".repeat(32),
    status: 1,
    agent_type: 1,
  });
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message: expect.stringContaining("hasn't finished setting up yet"),
  });
  expect(h.bestie.snapshot().canCreateNew).toBeFalsy();
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.events).toHaveLength(0);
});

it("turns check-in off and back on directly, without repeating the rest of setup", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  expect(await checkIn(h)).toMatchObject({ on: true });
  await h.bestie.setCheckIn(false);
  expect(h.requests("disable-bestie")).toHaveLength(1);
  expect(h.heartbeats).toHaveLength(0);
  expect(h.bestie.snapshot().checkIn).toEqual({ on: false, pending: false });
  await h.bestie.setCheckIn(true);
  expect(h.requests("enable-bestie")).toHaveLength(2);
  expect(h.bestie.snapshot().checkIn).toEqual({ on: true, pending: false });
  // Neither call touched the rest of setup.
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.requests("update-agent")).toHaveLength(1);
});

const saved = () => {
  const key = Object.keys(localStorage).find((name) =>
    name.startsWith("buzz.remote-bestie.v2:"),
  );
  return key ? JSON.parse(localStorage.getItem(key) ?? "{}") : undefined;
};
const welcomes = (h: Awaited<ReturnType<typeof bestieFixture>>, home: string) =>
  kinds(h, 9).filter((event) =>
    event.tags.some(([name, value]) => name === "h" && value === home),
  );

it("asks for Bestie's model before making it, with nothing preselected", async () => {
  const h = await bestieFixture(native.invoke);
  await h.raw.setup();
  expect(h.raw.snapshot()).toMatchObject({
    status: "choose-model",
    models: [
      {
        id: "model-a",
        displayName: "Model A",
        supportedReasoningEfforts: ["low", "high"],
      },
    ],
  });
  expect(h.requests("register-agent")).toHaveLength(0);
  expect(h.events).toHaveLength(0);
  await h.raw.chooseModel(MODEL);
  expect(h.raw.snapshot().status).toBe("ready");
  expect(h.rows).toHaveLength(1);
  expect(h.rows[0]).toMatchObject({
    model_id: "model-a",
    reasoning_effort: "high",
    agent_instructions: bestieInstructions(h.viewer, HOME),
  });
  // Finishing set the instructions with the model; no second update.
  expect(h.requests("update-agent")).toHaveLength(1);
});

it("asks for a model again when Builderlab says Bestie's choice is no longer valid", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  const row = h.rows[0];
  if (!row) throw new Error("Missing Bestie");
  row.model_selection_status = 3;
  const published = h.events.length;
  await h.raw.setup();
  expect(h.raw.snapshot()).toMatchObject({
    status: "choose-model",
    message: expect.stringContaining("needs a model"),
  });
  await h.raw.chooseModel({ modelId: "model-a", reasoningEffort: "low" });
  expect(h.raw.snapshot().status).toBe("ready");
  expect(row).toMatchObject({
    model_selection_status: 1,
    reasoning_effort: "low",
  });
  const last = h.requests("update-agent").at(-1)?.[1] as {
    request: { body: string };
  };
  expect(JSON.parse(last.request.body)).toEqual({
    agent_pubkey: h.agent,
    model_id: "model-a",
    reasoning_effort: "low",
  });
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.events).toHaveLength(published);
});

it("gives a replacement Bestie its own instructions and home after the first was instructed", async () => {
  const h = await bestieFixture(native.invoke);
  h.failPublication(9007);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("error");
  expect(saved()).toMatchObject({
    agent: h.agent,
    promptVersion: expect.any(String),
  });
  // Revoked outside this app, e.g. from another device.
  for (const row of h.rows) row.status = 3;
  await h.bestie.setup();
  expect(h.bestie.snapshot().canCreateNew).toBe(true);
  await h.bestie.setup(undefined, { createNew: true });
  expect(h.bestie.snapshot().status).toBe("ready");
  const record = saved();
  const replacement = h.rows[1];
  expect(replacement?.agent_pubkey).toBe(record.agent);
  expect(record.channelId).not.toBe(HOME);
  expect(replacement?.agent_instructions).toBe(
    bestieInstructions(h.viewer, record.channelId),
  );
  expect(h.channels.get(record.channelId)).toEqual({
    members: [h.viewer, record.agent],
    visibility: "private",
  });
  const intro = welcomes(h, record.channelId);
  expect(intro).toHaveLength(1);
  expect(intro[0]?.tags).toContainEqual(["p", record.agent]);
});

it("keeps the first Bestie's home and gives a replacement a new one after a failed welcome", async () => {
  const h = await bestieFixture(native.invoke);
  h.failPublication(9);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("error");
  expect(h.channels.get(HOME)?.members).toEqual([h.viewer, h.agent]);
  for (const row of h.rows) row.status = 3;
  await h.bestie.setup();
  expect(h.bestie.snapshot().canCreateNew).toBe(true);
  await h.bestie.setup(undefined, { createNew: true });
  expect(h.bestie.snapshot().status).toBe("ready");
  const record = saved();
  expect(record.agent).not.toBe(h.agent);
  expect(record.channelId).not.toBe(HOME);
  // The old conversation is preserved rather than reused with a stranger.
  expect(h.channels.get(HOME)?.members).toEqual([h.viewer, h.agent]);
  expect(h.channels.get(record.channelId)?.members).toEqual([
    h.viewer,
    record.agent,
  ]);
  expect(welcomes(h, HOME)).toHaveLength(0);
  const intro = welcomes(h, record.channelId);
  expect(intro).toHaveLength(1);
  expect(intro[0]?.tags).toContainEqual(["p", record.agent]);
});

it.each([
  ["home creation", 9007, "channelOperation"],
  ["welcome", 9, "welcomeId"],
] as const)(
  "recovers when the app ends before the %s reaches the Outbox journal",
  async (_, kind, field) => {
    const h = await bestieFixture(native.invoke);
    const gate = h.holdSave(kind);
    const first = h.bestie.setup();
    // The checkpoint is saved while the journal write is still pending.
    await vi.waitFor(() => expect(saved()?.[field]).toBeDefined());
    await h.crash();
    gate.resolve();
    await first;
    await h.bestie.setup();
    expect(h.bestie.snapshot().status).toBe("ready");
    expect(kinds(h, 9007)).toHaveLength(1);
    expect(h.channels.get(HOME)?.members).toEqual([h.viewer, h.agent]);
    const intro = kinds(h, 9);
    expect(intro).toHaveLength(1);
    expect(saved()?.welcomeId).toBe(intro[0]?.id);
  },
);

/** As if prompt.ts changed after this Bestie was set up. */
async function staleInstructions(h: Awaited<ReturnType<typeof bestieFixture>>) {
  const key = Object.keys(localStorage).find((name) =>
    name.startsWith("buzz.remote-bestie.v2:"),
  );
  if (!key) throw new Error("Missing Bestie record");
  localStorage.setItem(
    key,
    JSON.stringify({ ...saved(), promptVersion: "remote-bestie-1" }),
  );
  await h.restart();
  expect(h.bestie.snapshot().instructionsChanged).toBe(true);
}

it("changes check-in while an instruction update runs, and both take effect", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  await checkIn(h);
  await h.bestie.setCheckIn(false);
  await staleInstructions(h);
  await checkIn(h);
  const gate = h.holdRequest("update-agent");
  const updates = h.requests("update-agent").length;
  const update = h.bestie.setup();
  await vi.waitFor(() =>
    expect(h.requests("update-agent")).toHaveLength(updates + 1),
  );
  const toggle = h.bestie.setCheckIn(true);
  gate.resolve();
  await Promise.all([update, toggle]);
  expect(h.requests("enable-bestie")).toHaveLength(2);
  expect(saved()).toMatchObject({
    promptVersion: promptVersion(bestieInstructions(h.viewer, HOME)),
  });
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    checkIn: { on: true, pending: false },
  });
  expect(h.bestie.snapshot().instructionsChanged).toBeFalsy();
});

it("shows check-in results while a failed instruction update is still shown", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  await staleInstructions(h);
  await checkIn(h);
  h.reply("update-agent", 500, {});
  await h.bestie.setup();
  const failed = h.bestie.snapshot();
  expect(failed.status).toBe("error");
  await h.bestie.setCheckIn(false);
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message: failed.message,
    instructionsChanged: true,
    checkIn: { on: false, pending: false },
  });
  h.reply("enable-bestie", 200, {
    status: "failed",
    error_message: "No active Buzz agent",
  });
  await h.bestie.setCheckIn(true);
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message: failed.message,
    checkIn: { on: false, pending: false, problem: "No active Buzz agent" },
  });
});

it("shows check-in as the relay holds it, including a change made on another device", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  expect(await checkIn(h)).toMatchObject({ on: true });
  // Another device turned it off; this one saved nothing about check-in.
  h.heartbeats.splice(0);
  await h.restart();
  expect(await checkIn(h)).toEqual({ on: false, pending: false });
  expect(h.requests("enable-bestie")).toHaveLength(1);
});

it("shows check-in off once Bestie has left its home, whose relay turned it off", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  expect(await checkIn(h)).toMatchObject({ on: true });
  h.removeMember(h.agent);
  await h.restart();
  expect(await checkIn(h)).toEqual({ on: false, pending: false });
  await h.bestie.setCheckIn(true);
  expect(h.bestie.snapshot().checkIn).toMatchObject({
    on: false,
    problem: expect.stringContaining("not a member"),
  });
});

it("says why check-in could not be read, and still lets the owner change it", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  await checkIn(h);
  // Heartbeat reads fail across a reconnect; every other read answers.
  const answer = h.query.getMockImplementation();
  if (!answer) throw new Error("Missing relay");
  h.query.mockImplementation(async (filters) => {
    if (filters.some((filter) => filter.kinds?.includes(30620)))
      throw new Error("Relay unavailable");
    return answer(filters);
  });
  await h.restart();
  expect(await checkIn(h)).toEqual({
    pending: false,
    problem: expect.stringContaining("could not be read"),
  });
  h.query.mockImplementation(answer);
  await h.bestie.setCheckIn(true);
  expect(h.bestie.snapshot().checkIn).toEqual({ on: true, pending: false });
});

it("runs a resumed Bestie on the model the owner chose", async () => {
  const h = await bestieFixture(native.invoke);
  h.rows.push({
    key: "elsewhere",
    agent_id: "elsewhere",
    agent_name: "Bestie",
    agent_pubkey: "34".repeat(32),
    status: 2,
    agent_type: 1,
    model_id: "model-a",
    reasoning_effort: "low",
    model_selection_status: 1,
  });
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    record: { agent: "34".repeat(32), complete: true },
  });
  expect(h.rows.find((row) => row.agent_id === "elsewhere")).toMatchObject({
    model_id: MODEL.modelId,
    reasoning_effort: MODEL.reasoningEffort,
  });
});
