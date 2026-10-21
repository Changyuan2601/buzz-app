// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_INSTRUCTIONS_LENGTH } from "../builderlab/agents/client";
import { bestieInstructions, promptVersion } from "./prompt";
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
  expect(h.bestie.snapshot().record).toMatchObject({ checkIn: "on" });
  expect(h.bestie.snapshot().record?.checkInProblem).toBeUndefined();
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
    record: {
      complete: true,
      checkIn: "off",
      checkInProblem: "The relay rejected check-in: forbidden",
    },
  });
  // Setup only tries once; the switch owns the retry from here.
  await h.bestie.setup();
  expect(h.requests("enable-bestie")).toHaveLength(1);
  await h.bestie.setCheckIn(true);
  expect(h.requests("enable-bestie")).toHaveLength(2);
  expect(h.bestie.snapshot().record).toMatchObject({ checkIn: "on" });
  expect(h.bestie.snapshot().record?.checkInProblem).toBeUndefined();
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
  expect(h.bestie.snapshot().record).toMatchObject({ checkIn: "on" });
  await h.bestie.setCheckIn(false);
  expect(h.requests("disable-bestie")).toHaveLength(1);
  expect(h.bestie.snapshot().record).toMatchObject({ checkIn: "off" });
  expect(h.bestie.snapshot().record?.checkInProblem).toBeUndefined();
  await h.bestie.setCheckIn(true);
  expect(h.requests("enable-bestie")).toHaveLength(2);
  expect(h.bestie.snapshot().record).toMatchObject({ checkIn: "on" });
  expect(h.bestie.snapshot().record?.checkInProblem).toBeUndefined();
  // Neither call touched the rest of setup.
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.requests("update-agent")).toHaveLength(1);
});
