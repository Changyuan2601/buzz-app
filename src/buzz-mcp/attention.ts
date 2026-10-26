// The attention tools: an agent manages its own Interests, event watches and
// timers, with Janet's verbs and scoped object contract. Only the in-app server
// offers them, and only while the owner has attention on for the agent; the
// standalone server has no attention store. Every answer is JSON and names
// whether a classifier can run now, so the agent never configures one that it
// believes works when it does not. How to use them is in their descriptions,
// not the system prompt, so a session pays for it only once it loads them.
import type {
  AttentionValue,
  EventWatch,
  TimerWatch,
} from "../features/agents/attention";
import type {
  ShownObject,
  WriteOptions,
} from "../features/agents/attention-objects";
import type { AgentAttention } from "../features/agents/service";
import type { Tool } from "./tools";

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const bool = { type: "boolean" } as const;
const id = { ...str, description: "1-64 visible ASCII characters." };
const token = {
  ...str,
  description:
    "From your latest show or write of this object; object-v1:absent to create. On conflict, show and decide again.",
};
const scope = {
  ...str,
  description: "The Interest you work for; another's object is wrong-scope.",
};
const unbounded = {
  anyOf: [int, { type: "string", enum: ["unbounded"] }],
} as const;
const question = {
  type: "object",
  properties: {
    question: str,
    true: str,
    false: str,
    guidance: str,
    threshold: {
      type: "number",
      description:
        "Yes probability that passes; default 0.2; lower passes more. Change only with eval evidence.",
    },
  },
  required: ["question"],
  additionalProperties: false,
} as const;
/** The editable fields of a watch, as watch_add and watch_update take them. */
const watchFields = {
  name: str,
  enabled: bool,
  channel: {
    ...str,
    description:
      "Delivery channel UUID; omit for an independent Interest turn.",
  },
  root: {
    ...str,
    description: "Delivery thread root; requires channel.",
  },
  since: {
    anyOf: [int, { type: "string", enum: ["now"] }],
    description: "Event: ignore events before this Unix time.",
  },
  channels: {
    anyOf: [
      { type: "string", enum: ["all"] },
      { type: "array", items: str },
    ],
    description: 'Event: channel ids, or "all".',
  },
  kinds: {
    type: "array",
    items: int,
    description: "Event kinds; empty matches any.",
  },
  authors: {
    type: "array",
    items: str,
    description: "Only events by these hex pubkeys.",
  },
  exclude_authors: {
    type: "array",
    items: str,
    description: "No events by these hex pubkeys. Not with authors.",
  },
  tags: {
    type: "object",
    additionalProperties: { type: "array", items: str },
    description: "One-letter tag to accepted values.",
  },
  is_reply: {
    ...bool,
    description: "True for thread replies only, false for top-level only.",
  },
  classifier: {
    type: "object",
    properties: {
      questions: {
        type: "object",
        additionalProperties: question,
        description: "Named yes/no questions.",
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  prompt: { ...str, description: "Timer: what to do when it fires." },
  interval_secs: { ...int, description: "Timer: at least 60." },
  max_occurrences: { ...unbounded, description: "Timer: default 1." },
  expires_at: {
    ...unbounded,
    description: "Timer: Unix time it stops.",
  },
} as const;
/** Said by both tools that create objects, one of which any first use loads. */
const WRITES =
  "A successful write is authoritative: show again only when a later decision needs the current object. After an ambiguous result, show before retrying; report conflicts and failures. wrong-scope: the object belongs to another Interest. Attention grants no channel membership or authority to act. These tools work only while your owner has attention on.";
const tool = (
  name: string,
  description: string,
  properties: Readonly<Record<string, object>>,
  required: readonly string[] = [],
): Tool => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  },
});

export const ATTENTION_TOOLS: readonly Tool[] = [
  tool(
    "interest_set",
    `Create an Interest, or replace its instructions. Your attention is yours to manage: Interests say what you are responsible for, event watches wake you when a matching event arrives, and timers wake you on a schedule (watch_add). Subscriptions say what wakes you and may specify a conversation delivery address. Keep the task and reporting policy in the Interest instructions. ${WRITES}`,
    { id, instructions: str, expected_state: token },
    ["id", "instructions", "expected_state"],
  ),
  tool("interest_show", "One Interest and its expected_state.", { id }, ["id"]),
  tool("interest_list", "Interest ids.", { search: str }),
  tool(
    "interest_remove",
    "Remove an Interest that has no watches: once it has no remaining purpose, remove its watches, then it.",
    { id, expected_state: token },
    ["id", "expected_state"],
  ),
  tool(
    "watch_add",
    `Add a new event watch (needs since and channels) or timer (needs prompt and interval_secs) to an Interest.

Event watch: sees only new events while it is on, in channels you belong to ("all" means those); an earlier since does not replay. Matching watches run independently. Use deterministic filters (kinds, authors, tags, is_reply) for hard rules and the classifier only for judgment. When it reports to the owner, exclude_authors: ["OWNER_HEX"] unless their messages are the signal.

Classifier: Jev tests relevance of one filtered event with its channel, parent message and author role; no history or tools. Ask few named yes/no questions, one thing each, about facts the Interest needs, not message types, accepting any phrasing. Any yes passes, so more questions pass more; for "A but not B", write one question. Example: {"questions":{"release_blocked":{"question":"Does the event say the release is blocked?","true":"A blocker in any form.","false":"Routine progress, or a non-blocking problem."}}}. guidance holds examples and exclusions. Put actions in the Interest, not the questions. Uncertain cases and errors pass. Answers say whether a classifier can run; you can still save one, and until it runs its events pass unchecked.

Delivery, for either type: channel, with optional root, runs the wake in that conversation and makes it the default posting destination. Interest reporting instructions take precedence, and it grants no permission.

Timer: fires once unless max_occurrences allows more, rescheduling itself while it and expires_at allow; its final wake says it is the last.

${WRITES}`,
    {
      interest: str,
      id,
      type: { type: "string", enum: ["event", "timer"] },
      expected_state: token,
      ...watchFields,
    },
    ["interest", "id", "type", "expected_state"],
  ),
  tool(
    "watch_update",
    'Change only the fields given; clear removes optional fields, such as a classifier with clear: ["classifier"]. When widening a watch, set its since floor to the change time. A timer keeps its next run when its interval changes; use watch_rearm to schedule it from now. How selectors, classifiers and timer budgets work is in watch_add.',
    {
      id,
      interest: scope,
      expected_state: token,
      ...watchFields,
      clear: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "name",
            "channel",
            "root",
            "authors",
            "exclude_authors",
            "tags",
            "is_reply",
            "classifier",
          ],
        },
      },
    },
    ["id", "expected_state"],
  ),
  ...(
    [
      [
        "watch_enable",
        "Turn an event watch on. A timer is turned on by watch_rearm.",
      ],
      [
        "watch_disable",
        "Turn a watch off; it is kept. A timer stays off until watch_rearm.",
      ],
      [
        "watch_remove",
        "Remove a watch whose purpose is complete, superseded, or no longer relevant.",
      ],
    ] as const
  ).map(([name, description]) =>
    tool(name, description, { id, interest: scope, expected_state: token }, [
      "id",
      "expected_state",
    ]),
  ),
  tool(
    "watch_rearm",
    "Arm a timer, also one that is off: its next occurrence is one interval after at (default now, never earlier). Use it deliberately for a fresh deadline. It keeps its used occurrences and does not bypass expiration: a spent timer needs higher limits, which this takes too.",
    {
      id,
      interest: scope,
      expected_state: token,
      at: int,
      prompt: watchFields.prompt,
      interval_secs: int,
      max_occurrences: watchFields.max_occurrences,
      expires_at: watchFields.expires_at,
    },
    ["id", "expected_state"],
  ),
  tool(
    "watch_show",
    "One watch and its expected_state; for a timer, its used occurrences, next_due and status. An addressed watch also reports held or blocked delivery when destination membership is unconfirmed or absent.",
    { id, interest: scope },
    ["id"],
  ),
  tool("watch_list", "Watch summaries. status spent finds spent timers.", {
    interest: str,
    type: { type: "string", enum: ["event", "timer"] },
    status: {
      type: "string",
      enum: ["enabled", "disabled", "armed", "inactive", "spent"],
    },
    search: { ...str, description: "Case-sensitive, in ids and names." },
  }),
];

type Args = Readonly<Record<string, unknown>>;
const NAMES = new Set(ATTENTION_TOOLS.map((item) => item.name));
export const isAttentionTool = (name: string) => NAMES.has(name);

const UNAVAILABLE_NOTE =
  "No classifier can run on this device now, so this watch's events pass unchecked. It is kept, and runs once a classifier is available.";

/** Runs attention tool `name`. A throw is a tool error for the agent to read;
 * its text names the classifier state too. */
export async function callAttentionTool(
  attention: AgentAttention,
  name: string,
  args: Args,
) {
  const classifier = attention.classifier();
  try {
    return JSON.stringify(
      { classifier, ...(await run(attention, name, args, classifier)) },
      null,
      1,
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n(classifier: ${classifier})`,
    );
  }
}

async function run(
  attention: AgentAttention,
  name: string,
  args: Args,
  classifier: "available" | "unavailable",
): Promise<object> {
  const note = (object: ShownObject | null) =>
    classifier === "unavailable" &&
    object?.type === "event" &&
    object.classifier
      ? { classifier_note: UNAVAILABLE_NOTE }
      : {};
  const shown = async (promise: ReturnType<AgentAttention["show"]>) => {
    const result = await promise;
    return { ...result, ...note(result.object) };
  };
  const scoped = text(args.interest);
  const watch = (key: string) => `watch/${required(args, key)}`;
  const options = () => ({
    expected: required(args, "expected_state"),
    ...(scoped ? { interest: scoped } : {}),
  });
  /** Writes the stored watch with `change` applied. */
  const edit = async (
    change: (
      value: EventWatch | TimerWatch,
      shown: Readonly<{ used?: number }>,
    ) => object,
    write: Partial<WriteOptions> = {},
  ) => {
    const slug = watch("id");
    const current = (await attention.show(slug, scoped)).object;
    if (!current || current.type === "interest")
      throw new Error(`not-found: no watch ${String(args.id)}`);
    const value = change(
      stored(current) as EventWatch | TimerWatch,
      current.type === "timer" ? { used: current.used } : {},
    );
    return shown(
      attention.write(slug, value as AttentionValue, {
        ...options(),
        ...write,
      }),
    );
  };
  switch (name) {
    case "interest_set":
      return attention.write(
        `interest/${required(args, "id")}`,
        { type: "interest", instructions: required(args, "instructions") },
        { expected: required(args, "expected_state") },
      );
    case "interest_show":
      return attention.show(`interest/${required(args, "id")}`);
    case "interest_list":
      return { interests: attention.interests(text(args.search)) };
    case "interest_remove":
      return attention.write(`interest/${required(args, "id")}`, null, {
        expected: required(args, "expected_state"),
      });
    case "watch_add": {
      const interest = required(args, "interest");
      // As in Janet, adding never replaces: an existing watch is changed with
      // watch_update, which keeps the fields it is not given.
      if ((await attention.show(watch("id"))).object)
        refuse(`watch ${String(args.id)} exists; use watch_update`);
      const now = seconds();
      const value =
        args.type === "timer"
          ? {
              type: "timer",
              interest_id: interest,
              enabled: true,
              armed_at: now,
              max_occurrences: 1,
              expires_at: null,
              ...timerFields(args),
            }
          : args.type === "event"
            ? {
                type: "event",
                interest_id: interest,
                enabled: true,
                kinds: [],
                ...eventFields(args),
              }
            : fail('type must be "event" or "timer"');
      return shown(
        attention.write(watch("id"), value as AttentionValue, {
          expected: required(args, "expected_state"),
          interest,
        }),
      );
    }
    case "watch_update":
      return edit((value) => {
        const fields =
          value.type === "event" ? eventFields(args) : timerFields(args);
        const clear = Array.isArray(args.clear) ? args.clear : [];
        if (
          value.type === "timer" &&
          clear.some((key) => !["channel", "root"].includes(String(key)))
        )
          refuse("not an optional field of this timer");
        // Janet's rule: only a rearm arms a timer, with a new deadline.
        if (value.type === "timer" && !value.enabled && fields.enabled === true)
          refuse("use watch_rearm to turn a timer on");
        const next: Record<string, unknown> = { ...value, ...fields };
        for (const key of clear) delete next[String(key)];
        return next;
      });
    case "watch_enable":
    case "watch_disable":
      return edit((value) => {
        // Janet's rule: only a rearm arms a timer, with a new deadline.
        if (value.type === "timer" && name === "watch_enable")
          refuse("use watch_rearm to turn a timer on");
        return { ...value, enabled: name === "watch_enable" };
      });
    case "watch_rearm": {
      const { at, ...rest } = args;
      const now = seconds();
      if (at !== undefined && (typeof at !== "number" || at < now))
        fail("at must be a Unix time no earlier than now");
      return edit(
        (value, status) => {
          if (value.type !== "timer") refuse("only a timer can be rearmed");
          const next = { ...value, ...timerFields(rest) } as TimerWatch;
          // Janet's rule: rearming never resets usage, so a spent timer stays
          // spent until its limits are raised.
          const used = status.used ?? 0;
          if (
            (next.max_occurrences !== null && used >= next.max_occurrences) ||
            (next.expires_at !== null && now >= next.expires_at)
          )
            refuse(
              "the timer is spent; raise max_occurrences or expires_at to rearm it",
            );
          return {
            ...next,
            enabled: true,
            armed_at: typeof at === "number" ? at : now,
          };
        },
        { rearm: true },
      );
    }
    case "watch_remove":
      return attention.write(watch("id"), null, options());
    case "watch_show":
      return shown(attention.show(watch("id"), scoped));
    case "watch_list": {
      const search = text(args.search);
      return {
        watches: attention
          .watches({
            ...(scoped ? { interest: scoped } : {}),
            ...(args.type === "event" || args.type === "timer"
              ? { type: args.type }
              : {}),
            ...(typeof args.status === "string"
              ? { status: args.status as never }
              : {}),
            ...(search ? { search } : {}),
          })
          .map((summary) =>
            summary.classified && classifier === "unavailable"
              ? { ...summary, classifier: "unavailable" }
              : summary,
          ),
      };
    }
    default:
      throw new Error(`No tool ${name}`);
  }
}

/** The stored value of a shown watch: without the fields a show adds. */
function stored(object: ShownObject) {
  const {
    id: _,
    status: __,
    ...rest
  } = object as ShownObject & {
    status?: unknown;
  };
  const {
    used: ___,
    next_due: ____,
    ...value
  } = rest as Record<string, unknown>;
  return value;
}

const EVENT = [
  "channel",
  "root",
  "name",
  "enabled",
  "since",
  "channels",
  "kinds",
  "authors",
  "exclude_authors",
  "tags",
  "is_reply",
  "classifier",
];
const TIMER = [
  "channel",
  "root",
  "enabled",
  "prompt",
  "interval_secs",
  "max_occurrences",
  "expires_at",
];
function pick(args: Args, names: readonly string[], other: readonly string[]) {
  const wrong = other.filter((key) => !names.includes(key) && key in args);
  if (wrong.length) fail(`Not a field of this watch type: ${wrong.join(", ")}`);
  return Object.fromEntries(
    names
      .filter((key) => args[key] !== undefined)
      .map((key) => [key, args[key]]),
  );
}
function eventFields(args: Args) {
  const fields = pick(args, EVENT, TIMER);
  if (fields.since === "now") fields.since = seconds();
  return fields;
}
function timerFields(args: Args) {
  const fields = pick(args, TIMER, EVENT);
  for (const key of ["max_occurrences", "expires_at"])
    if (fields[key] === "unbounded") fields[key] = null;
  return fields;
}

const seconds = () => Math.floor(Date.now() / 1000);
const fail = (message: string): never => {
  throw new Error(`invalid: ${message}`);
};
/** A well-formed call that this object does not allow, as Janet reports it. */
const refuse = (message: string): never => {
  throw new Error(`invalid-operation: ${message}`);
};
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
function required(args: Args, name: string) {
  const value = args[name];
  if (typeof value === "string" && value) return value;
  if (name === "expected_state")
    refuse("every write needs the expected_state of a show");
  return fail(`${name} is required`);
}
