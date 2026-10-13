// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { MAX_INSTRUCTIONS_LENGTH } from "../builderlab/agents/client";
import { bestieInstructions, PROMPT_VERSION } from "./prompt";
import { RHYTHMS, rhythmYaml } from "./rhythms";
import { BUILDERLAB_TYPE } from "./setup";
import { bestieFixture, cleanups, HOME } from "./testing";

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  // Native identity signs the owner's attestation on desktop.
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        options: { signal: AbortSignal },
        work: () => Promise<void>,
      ) => {
        options.signal.throwIfAborted();
        return work();
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

it("keeps the kernel within Builderlab's instruction limit", () => {
  const kernel = bestieInstructions("ab".repeat(32), HOME);
  expect(kernel.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_LENGTH);
  expect(kernel).toContain(HOME);
  expect(kernel).toContain(PROMPT_VERSION);
});

it("creates hosted Bestie through Agents, then instructs, homes, introduces and saves paused rhythms", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    record: { agent: h.agent, channelId: HOME, complete: true },
  });
  // Agents made it at Builderlab and listed it as hosted for every device.
  expect(h.requests("register-agent")).toHaveLength(1);
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
  const rhythms = kinds(h, 30620);
  expect(rhythms).toHaveLength(RHYTHMS.length);
  for (const [index, key] of RHYTHMS.entries()) {
    const event = rhythms[index];
    expect(event?.pubkey).toBe(h.viewer);
    expect(event?.tags).toContainEqual(["h", HOME]);
    expect(event?.content).toBe(rhythmYaml(key, h.agent, HOME));
    expect(parse(event?.content ?? "")).toMatchObject({ enabled: false });
  }
});

it("reopens a finished setup after restart without another agent, channel, intro or workflow", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  const published = h.events.length;
  await h.restart();
  await h.bestie.setup();
  expect(h.bestie.snapshot().message).toBe("Your Bestie is set up.");
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.requests("update-agent")).toHaveLength(1);
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
    await h.agents.create({ type: BUILDERLAB_TYPE, name: "Bestie" });
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
  expect(h.rows[0]?.agent_instructions).toBeUndefined();
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

it("does not make a second Bestie while this community's agent list is unread", async () => {
  const h = await bestieFixture(native.invoke);
  h.rows.push({
    key: "elsewhere",
    agent_id: "elsewhere",
    agent_name: "Bestie",
    agent_pubkey: "34".repeat(32),
    status: 2,
  });
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message: expect.stringContaining("isn't listed in this community yet"),
  });
  expect(h.requests("register-agent")).toHaveLength(0);
  expect(h.events).toHaveLength(0);
});
