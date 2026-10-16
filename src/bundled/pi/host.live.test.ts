// @vitest-environment node
// The real host.mjs on Pi durable, with Pi's faux provider for a model: run
// with PI_DEPS set to a folder pi.sh installed Pi's packages in, such as
// "~/Library/Application Support/Buzz/pi/deps/<sum>".
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import host from "./host.mjs?raw";

const DEPS = process.env.PI_DEPS;
const run = promisify(execFile);

/** Serves the plugin's side over in-process streams, as Buzz would. */
const DRIVER = `
import { writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AuthFile, serve } from "./host.mjs";
const data = process.argv[2];
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const agent = "b".repeat(64);
const tools = [{ name: "send", description: "Post", inputSchema: { type: "object", properties: { text: { type: "string" }, final: { type: "boolean" } } } }];
const out = {};
function start() {
  const input = new PassThrough(), output = new PassThrough();
  const events = [], tools = [], pending = new Map();
  let id = 0;
  createInterface({ input: output }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "event") events.push(message.params);
    else if (message.method === "tool") {
      tools.push(message.params);
      const final = message.params.arguments.final === true;
      input.write(JSON.stringify({ id: message.id, result: { content: [{ type: "text", text: "sent" }], ...(final ? { final } : {}) } }) + "\\n");
    } else if (message.id !== undefined) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error));
      else call.resolve(message.result);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    input.write(JSON.stringify({ id, method, params }) + "\\n");
  });
  const { stop } = serve({ data, models, dir: data, input, output, exit: () => {} });
  return { rpc, events, tools, stop };
}
const turn = (request, text) => ({ agent, key: "chan/root", at: 100, context: { channel: "chan", root: "root" }, text, steer: "steer: " + text, request, provider: "faux", model: "faux-1", instructions: "Test.", cwd: data });
const held = () => { let release; const gate = new Promise((resolve) => (release = resolve)); return { gate, release }; };
const abortable = (gate, signal) => Promise.race([gate, new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]);
const started = (events, request) => new Promise((resolve) => { const check = () => events.some((event) => event.type === "placed" && event.request === request) ? resolve() : setTimeout(check, 5); check(); });

let pi = start();
await pi.rpc("open", { agent, tools });
// A provider only a Pi package adds is not one Buzz's Pi has.
out.unknown = await pi.rpc("test", { provider: "databricks", model: "m" }).catch((error) => error.message);
// A final send ends the run without another model call.
faux.setResponses([fauxAssistantMessage(fauxToolCall("buzz_send", { text: "hi", final: true }), { stopReason: "toolUse" })]);
const a = await pi.rpc("deliver", turn("A", "first"));
out.a = { ...(await pi.rpc("wait", { agent, submission: a.submission })), calls: faux.state.callCount, tools: pi.tools.splice(0), conversation: a.conversation };
// A plain answer, in the same conversation.
faux.setResponses([fauxAssistantMessage("Plain answer")]);
const b = await pi.rpc("deliver", turn("B", "second"));
out.b = { ...(await pi.rpc("wait", { agent, submission: b.submission })), conversation: b.conversation };
// What a transcript reads: the places, and the entries without schemas or usage.
out.places = (await pi.rpc("places", { agent })).places;
out.entries = (await pi.rpc("entries", { agent, conversation: a.conversation })).entries.map((entry) => [entry.kind, ...(entry.model ?? []).map((message) => message.role + (message.usage ? "+usage" : ""))]);
// A request while the run works steers it.
const c = held();
let saw = [];
faux.setResponses([
  async () => { await c.gate; return fauxAssistantMessage(fauxToolCall("buzz_send", { text: "working" }), { stopReason: "toolUse" }); },
  (context) => { saw = context.messages.filter((m) => m.role === "user").map((m) => m.content); return fauxAssistantMessage("Answer to both"); },
]);
const c1 = await pi.rpc("deliver", turn("C1", "third"));
await started(pi.events, "C1");
const c2 = await pi.rpc("deliver", turn("C2", "fourth"));
c.release();
out.c = { waits: await Promise.all([c1, c2].map((x) => pi.rpc("wait", { agent, submission: x.submission }))), saw, placed: pi.events.filter((e) => e.type === "placed").map((e) => [e.request, e.entry]), steps: pi.events.filter((e) => e.type === "step").map((e) => e.tool) };
// A run the host stops in continues in the next host.
const d = held(), calling = held();
faux.setResponses([
  async (_context, options) => { calling.release(); await abortable(d.gate, options?.signal); return fauxAssistantMessage("first try"); },
  () => fauxAssistantMessage("Resumed answer"),
]);
const d1 = await pi.rpc("deliver", turn("D", "fifth"));
await calling.gate;
const stopped = pi.rpc("wait", { agent, submission: d1.submission });
await pi.stop();
out.stopped = await stopped;
pi = start();
await pi.rpc("open", { agent, tools });
out.resumed = await pi.rpc("wait", { agent, submission: d1.submission });
// A run that fails leaves no request it was steered with waiting for the next.
const e = held();
faux.setResponses([async () => { await e.gate; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 Bad model" }); }]);
const e1 = await pi.rpc("deliver", turn("E1", "sixth"));
await started(pi.events, "E1");
const e2 = await pi.rpc("deliver", turn("E2", "seventh"));
e.release();
out.e = await Promise.all([e1, e2].map((x) => pi.rpc("wait", { agent, submission: x.submission })));
out.place = await pi.rpc("place", { agent, key: "chan/root" });
// A turn Pi could not start leaves what the conversation was shown.
out.unstarted = await pi.rpc("deliver", { ...turn("F", "eighth"), at: 200, model: "nope" }).catch((error) => error.message);
out.unstartedPlace = await pi.rpc("place", { agent, key: "chan/root" });
// Pi's settings as they are now, which the pi command changes.
await writeFile(data + "/settings.json", JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1" }));
out.defaults = await pi.rpc("defaults", {});
await pi.stop();
// Pi's auth.json: a change that returns nothing, as pi-ai's refresh does when
// another process refreshed first, keeps the sign-in.
const auth = new AuthFile(data + "/auth.json");
const signIn = { type: "oauth", access: "a", refresh: "r", expires: 1 };
await auth.modify("p", async () => signIn);
out.auth = { result: await auth.modify("p", async () => undefined), stored: await auth.read("p") };
console.log(JSON.stringify(out));
`;

describe.skipIf(!DEPS)("the Pi host on Pi durable", () => {
  const folders: string[] = [];
  afterAll(async () => {
    await Promise.all(
      folders.map((folder) => rm(folder, { recursive: true, force: true })),
    );
  });

  it("runs, steers, ends and resumes turns", async () => {
    const folder = await mkdtemp(join(tmpdir(), "buzz-pi-live-"));
    folders.push(folder);
    await symlink(
      join(DEPS ?? "", "node_modules"),
      join(folder, "node_modules"),
    );
    await writeFile(join(folder, "host.mjs"), host);
    await writeFile(join(folder, "driver.mjs"), DRIVER);
    const { stdout } = await run(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        join(folder, "driver.mjs"),
        folder,
      ],
      { cwd: folder, timeout: 60_000 },
    );
    const out = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
    expect(out.unknown).toMatch(
      /^Buzz can use only Pi's built-in providers, and databricks isn't one/,
    );
    expect(out.a).toMatchObject({ status: "done", calls: 1 });
    expect(out.a.tools).toEqual([
      {
        agent: "b".repeat(64),
        conversation: out.a.conversation,
        context: { channel: "chan", root: "root" },
        name: "send",
        arguments: { text: "hi", final: true },
      },
    ]);
    expect(out.places).toEqual([
      { key: "chan/root", conversation: out.a.conversation, seen: 100 },
    ]);
    // Newest first; a system entry's tool schemas are left out.
    expect(out.entries).toEqual([
      ["pi.assistant", "assistant"],
      ["pi.user", "user"],
      ["pi.tool-result", "toolResult"],
      ["pi.assistant", "assistant"],
      ["pi.system"],
      ["pi.user", "user"],
    ]);
    expect(out.b).toMatchObject({
      status: "done",
      text: "Plain answer",
      conversation: out.a.conversation,
    });
    const [first, second] = out.c.waits;
    expect(first).toMatchObject({ status: "done", text: "Answer to both" });
    expect(second).toEqual(first);
    expect(out.c.saw.slice(-2)).toEqual(["third", "steer: fourth"]);
    expect(out.c.placed.map(([request]: [string]) => request)).toEqual([
      "A",
      "B",
      "C1",
      "C2",
    ]);
    // Each placed at an entry before the run's answer, which the runtime
    // compares to find the latest request a run took.
    const [, c1] = out.c.placed[2];
    const [, c2] = out.c.placed[3];
    expect(c1).toBeLessThan(c2);
    expect(c2).toBeLessThan(first.answer);
    expect(out.c.steps).toContain("send");
    expect(out.stopped).toEqual({ status: "closed" });
    expect(out.resumed).toMatchObject({
      status: "done",
      text: "Resumed answer",
    });
    const [failed, withdrawn] = out.e;
    expect(failed).toMatchObject({
      status: "unanswered",
      detail: expect.stringContaining("400 Bad model"),
    });
    expect(withdrawn).toEqual(failed);
    expect(out.place).toEqual({ seen: 100 });
    expect(out.unstarted).toMatch(/Pi has no model nope/);
    expect(out.unstartedPlace).toEqual({ seen: 100 });
    expect(out.defaults).toEqual({ provider: "faux", model: "faux-1" });
    const signIn = { type: "oauth", access: "a", refresh: "r", expires: 1 };
    expect(out.auth).toEqual({ result: signIn, stored: signIn });
  }, 90_000);
});
