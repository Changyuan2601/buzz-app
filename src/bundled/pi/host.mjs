// Buzz's Pi host: Pi durable for this computer's Pi agents, driven by the Pi
// plugin over stdio, one JSON message a line. Each agent has its own Harness
// in its own SQLite file, and each Buzz conversation is one Pi conversation
// in it, found again through the `buzz.places` document. The Buzz tools run
// in the app, which holds the agent's key: a call to one here is a request
// back to the plugin. `pi.sh` runs this with Node in the folder its packages
// are installed in.
import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
} from "@earendil-works/chord/context";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  AssistantEntry,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  Harness,
  section,
  watchEvents,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import lockfile from "proper-lockfile";

const context = BACKGROUND_CONTEXT;
/** Each Buzz conversation key's Pi conversation, the tools' default
 * destination for it, and the newest message it has been shown. */
const Places = defineDoc({
  kind: "buzz.places",
  version: 1,
  scope: "session",
  initial: () => ({}),
});
/** Messages that arrive while Pi works join its run at the next boundary. */
const SETTINGS = { steeringMode: "all", followUpMode: "all" };
/** Pi's own default thinking level, for a model that thinks. */
const THINKING = "medium";
/** A lock left by a host that was killed is taken over after this long. */
const STALE_MS = 30_000;
const TEST_TIMEOUT_MS = 30_000;
/** Entries a transcript reads at a time. */
const PAGE = 200;
/** Buzz tools are `buzz_<name>`, apart from Pi's own `read` and `edit`. */
const PREFIX = "buzz_";
const TOOL_NAMES = `The Buzz tools are named \`${PREFIX}<name>\`: where your instructions name a Buzz tool such as \`send\` or \`read\`, call \`${PREFIX}send\` or \`${PREFIX}read\`. The unprefixed \`read\`, \`write\`, \`edit\` and \`bash\` work on files in the workspace.`;

/** Pi's folder, shared with the `pi` command: its keys and settings. */
export const piDir = () => {
  const dir = process.env.PI_CODING_AGENT_DIR;
  return dir
    ? dir.replace(/^~(?=$|\/)/, homedir())
    : join(homedir(), ".pi", "agent");
};

/** Pi's `auth.json`, read and written as the `pi` command does, under the
 * same lock, so keys saved in either work in both. */
export class AuthFile {
  commands = new Map();
  constructor(path) {
    this.path = path;
  }
  async load() {
    let text;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`${this.path} is not a JSON object`);
    return parsed;
  }
  async read(id) {
    const credential = (await this.load())[id];
    return credential?.type === "api_key" && credential.key
      ? { ...credential, key: this.resolve(credential.key) }
      : credential;
  }
  async list() {
    return Object.entries(await this.load()).map(([providerId, value]) => ({
      providerId,
      type: value.type,
    }));
  }
  /** As pi-ai's stores do: a change that returns nothing, such as a refresh
   * another process already made, leaves the entry. */
  modify(id, change) {
    return this.locked(async (all) => {
      const next = await change(all[id]);
      if (next !== undefined) all[id] = next;
      return all[id];
    });
  }
  async delete(id) {
    await this.locked((all) => {
      delete all[id];
    });
  }
  /** As in `pi`: `!command` runs it for the key, and `$NAME` or `${NAME}`
   * reads it from the environment. */
  resolve(key) {
    if (key.startsWith("!")) {
      if (!this.commands.has(key))
        try {
          this.commands.set(
            key,
            execSync(key.slice(1), {
              encoding: "utf8",
              timeout: 10_000,
              stdio: ["ignore", "pipe", "ignore"],
            }).trim() || undefined,
          );
        } catch {
          this.commands.set(key, undefined);
        }
      return this.commands.get(key);
    }
    const name = /^\$(?:\{(\w+)\}|(\w+))$/.exec(key);
    return name ? process.env[name[1] ?? name[2]] : key;
  }
  async locked(change) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, "{}", { flag: "wx", mode: 0o600 }).catch(
      (error) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: STALE_MS,
      retries: { retries: 30, minTimeout: 20, maxTimeout: 2_000 },
    });
    try {
      const all = await this.load();
      const result = await change(all);
      await writeFile(this.path, `${JSON.stringify(all, null, 2)}\n`, {
        mode: 0o600,
      });
      return result;
    } finally {
      await release();
    }
  }
}

/** Why a provider that a Pi package adds, which Buzz doesn't load, can't run. */
const notBuiltIn = (id) =>
  `Buzz can use only Pi's built-in providers, and ${id} isn't one. It may come from a Pi package. Choose another provider in the agent's Settings.`;

/** The default provider, model and thinking level in Pi's settings. */
async function piDefaults(dir) {
  try {
    const settings = JSON.parse(
      await readFile(join(dir, "settings.json"), "utf8"),
    );
    const text = (value) =>
      typeof value === "string" && value ? value : undefined;
    return {
      provider: text(settings.defaultProvider),
      model: text(settings.defaultModel),
      thinking: text(settings.defaultThinkingLevel),
    };
  } catch {
    return {};
  }
}

/** A message as a transcript shows it: no usage, image data or signatures. */
const slim = ({ usage, ...message }) =>
  Array.isArray(message.content)
    ? {
        ...message,
        content: message.content.map((part) =>
          part.type === "image"
            ? { type: "image" }
            : part.type === "thinking"
              ? { type: "thinking", thinking: part.thinking }
              : part,
        ),
      }
    : message;

const textOf = (message) =>
  (message?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();

/** What a step shows of a tool call, as Claude's steps do. */
const TARGETS = ["path", "file_path", "pattern", "url", "query", "command"];
const targetOf = (args) => {
  const value = TARGETS.map((key) => args?.[key]).find(
    (item) => typeof item === "string" && item,
  );
  return value?.startsWith("/") ? value.split("/").at(-1) : value;
};

/** Serves the plugin on `input` and `output` until `input` closes. */
export function serve({
  data,
  models,
  dir = piDir(),
  input = process.stdin,
  output = process.stdout,
  exit = () => process.exit(0),
}) {
  /** Each agent's open Harness, by pubkey. */
  const agents = new Map();
  const calls = new Map();
  let called = 0;
  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  const notify = (method, params) => write({ method, params });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `h${++called}`;
      calls.set(id, { resolve, reject });
      write({ id, method, params });
    });

  /** The model a turn runs on: the agent's, or else Pi's default. */
  async function choose({ provider, model, thinking }) {
    const defaults = await piDefaults(dir);
    const id = provider || defaults.provider;
    const modelId =
      model || (id === defaults.provider ? defaults.model : undefined);
    if (id && !models.getProvider(id)) throw new Error(notBuiltIn(id));
    if (!id || !modelId)
      throw new Error(
        "This agent has no model. Choose a provider and model in its Settings.",
      );
    const found = models.getModel(id, modelId);
    if (!found) throw new Error(`Pi has no model ${modelId} from ${id}`);
    return {
      model: { provider: id, modelId },
      thinkingLevel: clampThinkingLevel(
        found,
        thinking || defaults.thinking || THINKING,
      ),
    };
  }

  async function open(agent) {
    if (!/^[0-9a-f]{64}$/.test(agent)) throw new Error("Not an agent key");
    const path = join(data, "agents", `${agent}.sqlite`);
    await mkdir(dirname(path), { recursive: true });
    // One host at a time per agent, across every Buzz build here. A lock that
    // a killed host left is taken over once it is stale.
    const release = await lockfile
      .lock(path, {
        realpath: false,
        stale: STALE_MS,
        retries: { retries: 12, minTimeout: 1_000, maxTimeout: 5_000 },
        onCompromised: (error) =>
          console.error("Pi lost its lock on an agent's storage", error),
      })
      .catch((error) => {
        throw error.code === "ELOCKED"
          ? new Error("This agent is open in another Buzz app on this computer")
          : error;
      });
    try {
      const registry = createRegistry();
      registry.install(CodingTools);
      const harness = await Harness.open(
        await openNodeSqliteStorage(path),
        {
          models,
          registry,
          settings: SETTINGS,
          env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? homedir() }),
          onReport: (error) => console.error("Pi reported", error),
        },
        context,
      );
      const opened = {
        agent,
        harness,
        registry,
        release,
        tools: "",
        /** Each conversation's tool context, for runs resumed after a restart. */
        contexts: new Map(),
        /** Each watched conversation, and whether a run is in it. */
        watched: new Map(),
        /** Deliveries to each conversation key, one after another. */
        queues: new Map(),
        closing: false,
      };
      const places = (await harness.snapshot(Places, context)) ?? {};
      for (const place of Object.values(places))
        opened.contexts.set(place.conversation, place.context);
      return opened;
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }
  }

  /** The agent's storage, opened once. */
  function opening(agent) {
    let started = agents.get(agent);
    if (!started) {
      started = open(agent);
      agents.set(agent, started);
      started.catch(() => {
        if (agents.get(agent) === started) agents.delete(agent);
      });
    }
    return started;
  }

  async function agentOf(agent) {
    const opened = await agents.get(agent);
    if (!opened || opened.closing) throw new Error("The agent is not open");
    return opened;
  }

  /** The agent's Buzz tools, served by the plugin. */
  function buzz(opened, tools) {
    return defineExtension({
      name: "buzz",
      sections: [section("buzz-tools", () => TOOL_NAMES)],
      tools: tools.map((tool) =>
        defineTool({
          name: `${PREFIX}${tool.name}`,
          description: tool.description ?? "",
          parameters: tool.inputSchema ?? { type: "object" },
          async execute(args, api, signalled) {
            // Given up when the run is stopped, so closing the agent does
            // not wait on Buzz.
            const result = await awaitWithContext(
              call("tool", {
                agent: opened.agent,
                conversation: api.conversationId,
                context: opened.contexts.get(api.conversationId) ?? {},
                name: tool.name,
                arguments: args,
              }),
              signalled,
            );
            return {
              content: (result.content ?? []).map((part) =>
                part.type === "image" || part.type === "text"
                  ? part
                  : { type: "text", text: JSON.stringify(part) },
              ),
              ...(result.isError ? { isError: true } : {}),
              // A final `send` answered the run; Pi ends it without another
              // model call, and starts a new one for what arrived meanwhile.
              ...(result.final ? { control: { terminate: true } } : {}),
            };
          },
        }),
      ),
    });
  }

  /** Watches a conversation for its steps, whether it is working, and when
   * each request joins its run. */
  async function watch(opened, conversation) {
    let watched = opened.watched.get(conversation);
    if (watched) return watched;
    const stream = await watchEvents(opened.harness, conversation, context);
    watched = { busy: Boolean(stream.snapshot.run), stream };
    opened.watched.set(conversation, watched);
    const send = (event) =>
      notify("event", { agent: opened.agent, conversation, ...event });
    const state = watched;
    stream.start(async (events) => {
      for (const event of events)
        if (event.type === "run_start") state.busy = true;
        else if (event.type === "run_end") state.busy = false;
        else if (
          event.type === "submission" &&
          event.record.status === "placed" &&
          event.record.requestId
        )
          send({ type: "placed", request: event.record.requestId });
        else if (event.type === "tool_execution_start")
          send({
            type: "step",
            tool: event.toolName.startsWith(PREFIX)
              ? event.toolName.slice(PREFIX.length)
              : event.toolName,
            target: targetOf(event.args),
          });
        else if (event.type === "message_update")
          for (const change of event.changes)
            if (change.type === "thinking_start")
              send({ type: "step", tool: "Thinking" });
            else if (change.type === "text_start")
              send({ type: "step", tool: "Writing reply" });
    });
    return watched;
  }

  async function settle(opened, id) {
    const submission = await opened.harness.submission(id, context);
    if (!submission) throw new Error("Pi has no record of this request");
    let record;
    try {
      record = await submission.wait(context);
    } catch (error) {
      if (opened.closing) return { status: "closed" };
      throw error;
    }
    if (record.status !== "done")
      return {
        status: "unanswered",
        reason: record.reason,
        ...(record.detail ? { detail: String(record.detail) } : {}),
      };
    const entry = await opened.harness.commit(
      (tx) => tx.entry(AssistantEntry, record.answer),
      context,
    );
    return {
      status: "done",
      answer: record.answer,
      text: textOf(entry?.model?.at(-1)),
    };
  }

  /** Starts a request in a conversation configured for this turn. */
  async function submit(opened, conversation, turn) {
    await conversation.configure(
      {
        ...(await choose(turn)),
        instructions: turn.instructions,
        cwd: turn.cwd.replace(/^~(?=$|\/)/, homedir()),
      },
      context,
    );
    const watched = await watch(opened, conversation.id);
    const submission = await conversation.submit(
      {
        type: "input",
        content: watched.busy && turn.steer ? turn.steer : turn.text,
        whenBusy: "steer",
        requestId: turn.request,
      },
      context,
    );
    return { submission: submission.id, conversation: conversation.id };
  }

  const methods = {
    async providers() {
      const providers = [];
      for (const provider of models.getProviders()) {
        if (!models.getModels(provider.id).length) continue;
        const auth = await models.checkAuth(provider.id).catch(() => undefined);
        providers.push({
          id: provider.id,
          name: provider.name,
          key: Boolean(provider.auth.apiKey),
          signsIn: Boolean(provider.auth.oauth),
          ...(auth ? { configured: auth.source ?? auth.type } : {}),
        });
      }
      providers.sort((a, b) => a.name.localeCompare(b.name));
      return { providers, defaults: await piDefaults(dir) };
    },
    models({ provider }) {
      return models.getModels(provider).map((model) => ({
        id: model.id,
        name: model.name,
        thinking: getSupportedThinkingLevels(model),
      }));
    },
    /** Saves a key with Pi's own login for the provider, which takes only a
     * key here: one that asks for more is set up with `pi`. */
    async login({ provider, key }) {
      const name = models.getProvider(provider)?.name ?? provider;
      let given = false;
      await models.login(provider, "api_key", {
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        notify() {},
        async prompt(prompt) {
          if (prompt.type === "secret" && !given) {
            given = true;
            return key;
          }
          throw new Error(
            `${name} needs more than an API key. Set it up with the pi command's /login, then choose it here.`,
          );
        },
      });
      return {};
    },
    /** Asks the model for one short reply. */
    async test(turn) {
      const { model } = await choose(turn);
      const reply = await models.completeSimple(
        models.getModel(model.provider, model.modelId),
        {
          messages: [
            { role: "user", content: "Reply with OK.", timestamp: Date.now() },
          ],
        },
        {
          maxTokens: 32,
          maxRetries: 0,
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        },
      );
      return reply.stopReason === "error" || reply.stopReason === "aborted"
        ? {
            ok: false,
            message: reply.errorMessage || "The provider did not answer",
          }
        : { ok: true, message: `Connected to ${model.modelId}` };
    },
    /** Opens the agent's storage, once, with its Buzz tools as they are now. */
    async open({ agent, tools }) {
      const opened = await opening(agent);
      const listed = JSON.stringify(tools);
      if (opened.tools !== listed) {
        opened.registry.install(buzz(opened, tools));
        opened.tools = listed;
      }
      return {};
    },
    /** The agent's Buzz conversations: each key's Pi conversation, and the
     * newest message it has been shown. Storage opened only to be read runs
     * nothing: Pi durable resumes work only when asked for progress. */
    async places({ agent }) {
      const { harness } = await opening(agent);
      const places = (await harness.snapshot(Places, context)) ?? {};
      return {
        places: Object.entries(places).map(([key, place]) => ({
          key,
          conversation: place.conversation,
          seen: place.seen,
        })),
      };
    },
    /** A page of a conversation's entries, newest first, as a transcript
     * shows them. */
    async entries({ agent, conversation, cursor }) {
      const { harness } = await opening(agent);
      const found = await harness.conversation(conversation, context);
      if (!found) return { entries: [] };
      const page = await found.entries({}, PAGE, cursor, context);
      return {
        entries: page.items.map(({ id, kind, model }) => ({
          id,
          kind,
          // System entries hold every tool's schema; a transcript shows none.
          ...(model && kind !== "pi.system" ? { model: model.map(slim) } : {}),
        })),
        ...(page.next ? { next: page.next } : {}),
      };
    },
    /** The newest message a conversation key's Pi conversation has been
     * shown; 0 when it has none yet. */
    async place({ agent, key }) {
      const { harness } = await agentOf(agent);
      const place = (await harness.snapshot(Places, context))?.[key];
      return {
        seen:
          place && (await harness.conversation(place.conversation, context))
            ? place.seen
            : 0,
      };
    },
    /** A turn for a conversation key: its Pi conversation, made the first
     * time, takes the request, or steers its run if one is working. */
    async deliver({ agent, key, at, context: tools, ...turn }) {
      const opened = await agentOf(agent);
      const prior = opened.queues.get(key);
      const delivered = (async () => {
        await prior?.catch(() => undefined);
        const { harness } = opened;
        const place = (await harness.snapshot(Places, context))?.[key];
        const conversation =
          (place &&
            (await harness.conversation(place.conversation, context))) ||
          (await harness.createConversation(
            { ownership: { kind: "ownerless" } },
            context,
          ));
        await harness.commit(async (tx) => {
          const places = await tx.doc(Places);
          places[key] = {
            conversation: conversation.id,
            context: tools,
            seen: Math.max(at, places[key]?.seen ?? 0),
          };
        }, context);
        opened.contexts.set(conversation.id, tools);
        return submit(opened, conversation, turn);
      })();
      opened.queues.set(key, delivered);
      const done = () => {
        if (opened.queues.get(key) === delivered) opened.queues.delete(key);
      };
      void delivered.then(done, done);
      return delivered;
    },
    /** A one-off turn in a conversation of its own, with no default
     * destination for its tools. */
    async once({ agent, ...turn }) {
      const opened = await agentOf(agent);
      const conversation = await opened.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
      );
      return submit(opened, conversation, turn);
    },
    /** How a request settled: its answer's text, or why it has none. */
    async wait({ agent, submission }) {
      return settle(await agentOf(agent), submission);
    },
    async abort({ agent, conversation }) {
      const { harness } = await agentOf(agent);
      await (await harness.conversation(conversation, context))?.abort(context);
      return {};
    },
    /** Closes the agent's storage. Unfinished runs stay, and continue when it
     * opens again. */
    async close({ agent }) {
      const opening = agents.get(agent);
      agents.delete(agent);
      await shut(await opening?.catch(() => undefined));
      return {};
    },
  };

  async function shut(opened) {
    if (!opened || opened.closing) return;
    opened.closing = true;
    for (const { stream } of opened.watched.values())
      await stream.stop().catch(() => undefined);
    await opened.harness.close(context).catch((error) => {
      console.error("Pi could not close an agent", error);
    });
    await opened.release().catch(() => undefined);
  }

  async function handle({ id, method, params }) {
    try {
      const run = methods[method];
      if (!run) throw new Error(`Unknown method ${method}`);
      write({ id, result: (await run(params ?? {})) ?? {} });
    } catch (error) {
      write({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let stopping;
  const stop = () => {
    stopping ??= Promise.all(
      [...agents.values()].map((opening) =>
        opening.then(shut, () => undefined),
      ),
    ).finally(exit);
    return stopping;
  };
  const lines = createInterface({ input });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method) void handle(message);
    else {
      const pending = calls.get(message.id);
      calls.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error));
      else pending?.resolve(message.result ?? {});
    }
  });
  // The plugin closes stdin to stop the host; each agent's storage closes
  // first, so the next host can open it at once.
  lines.on("close", stop);
  notify("ready", {});
  return { stop };
}

if (process.env.BUZZ_PI_HOST === "1") {
  const dir = piDir();
  const { stop } = serve({
    data: process.argv[1],
    models: builtinModels({
      credentials: new AuthFile(join(dir, "auth.json")),
    }),
    dir,
  });
  process.on("SIGTERM", stop);
}
