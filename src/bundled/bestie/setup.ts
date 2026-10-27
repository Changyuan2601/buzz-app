import type { Agents } from "../../features/agents/service";
import { randomAgentAvatar } from "../../features/agents/avatar-packs";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { Builderlab } from "../builderlab/service";
import {
  MAX_INSTRUCTIONS_LENGTH,
  type RemoteAgentModel,
} from "../builderlab/agents/client";
import { disableCheckIn, enableCheckIn, readCheckIn } from "./checkin";
import { bestieHome, bestieInstructions, promptVersion } from "./prompt";

/** The Builderlab hosted type's Agents key, `pluginId/typeId`. */
export const BUILDERLAB_TYPE = "block.builderlab/builderlab";
export const NAME = "Bestie";

type Record = {
  version: 1;
  owner: string;
  /** Reserved before anything else, so every retry reuses one home. */
  channelId: string;
  agent?: string | undefined;
  channelOperation?: string | undefined;
  channelFailed?: boolean | undefined;
  promptVersion?: string | undefined;
  welcomeId?: string | undefined;
  welcomeFailed?: boolean | undefined;
  complete?: boolean | undefined;
};
/** Bestie's hourly check-in as the relay holds it, never saved locally. */
type CheckIn = Readonly<{
  /** Absent until the relay has been read. */
  on?: boolean | undefined;
  /** A change or read is in flight. */
  pending: boolean;
  /** Why the last change or read failed, if it did. */
  problem?: string | undefined;
}>;
/** The Builderlab model Bestie runs on; Builderlab offers no default. */
export type ModelChoice = Readonly<{
  modelId: string;
  reasoningEffort: string;
}>;
type State = Readonly<{
  status: "unavailable" | "idle" | "busy" | "choose-model" | "ready" | "error";
  message: string;
  /** Builderlab's catalog, while the owner chooses Bestie's model. */
  models?: readonly RemoteAgentModel[];
  record?: Record | undefined;
  connection?: RelaySnapshot;
  /** A set-up Bestie whose instructions differ from prompt.ts. */
  instructionsChanged?: boolean;
  /** A set-up Bestie's hourly check-in. */
  checkIn?: CheckIn;
}>;
type SetupOptions = Readonly<{ model?: ModelChoice }>;
const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function read(key: string, owner: string): Record | undefined {
  const raw = localStorage.getItem(key);
  if (!raw) return;
  let record: Record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new Error(
      "Saved Bestie setup is unreadable. No new agent was created.",
    );
  }
  if (
    record?.version !== 1 ||
    record.owner !== owner ||
    !HEX.test(owner) ||
    !UUID.test(record.channelId) ||
    (record.agent !== undefined && !HEX.test(record.agent)) ||
    (record.complete && (!record.agent || !record.promptVersion)) ||
    [record.channelOperation, record.welcomeId].some(
      (id) => id !== undefined && !HEX.test(id),
    )
  )
    throw new Error(
      "Saved Bestie setup is invalid. Review it before retrying.",
    );
  return record;
}

/** Whether a set-up Bestie's instructions differ from the current prompt. */
function changed(record: Record) {
  return (
    record.promptVersion !==
    promptVersion(bestieInstructions(record.owner, record.channelId))
  );
}

/** Builderlab's gates surface as HTTP statuses on its client errors. */
function explain(error: unknown) {
  const status =
    error instanceof Error && "status" in error ? Number(error.status) : 0;
  // Owner actions need the Buzz or Builderlab capability, which account
  // screening withholds until the owner's details pass (cash-server #136123).
  if (status === 403)
    return "Builderlab won't let this account run remote agents yet. If Builderlab asks you to finish your account details, complete them there, then retry setup.";
  return error instanceof Error
    ? error.message
    : "Bestie setup failed. Retry to continue.";
}

/** Setup coordinates existing owners: Agents makes and lists Bestie,
 * Builderlab holds its instructions, the session writes the home channel. */
export function createRemoteBestie(
  builderlab: Builderlab,
  agents: Agents,
  relay: RelayData,
) {
  let disposed = false;
  let operation: AbortController | undefined;
  let work: Promise<void> | undefined;
  let state: State = { status: "unavailable", message: "" };
  /** The set-up Bestie whose check-in `checkIn` describes. */
  let checkInFor:
    | Readonly<{
        session: RelaySnapshot["session"];
        agent: string;
        channelId: string;
      }>
    | undefined;
  let checkIn: CheckIn | undefined;
  let checkInOperation: AbortController | undefined;
  /** A setup result (error or choice) that only a retry or reconnect clears. */
  let held = false;
  /** The setup request waiting for the owner's model choice. */
  const listeners = new Set<() => void>();
  const publish = (next: State) => {
    const { checkIn: _, ...rest } = next;
    state = follow(next) && checkIn ? { ...rest, checkIn } : rest;
    for (const listener of listeners) listener();
  };
  /** Whether `next` shows a set-up Bestie; starts reading its check-in from
   * the relay the first time this connection shows it. */
  function follow(next: State) {
    const record = next.record;
    const session = next.connection?.session;
    if (!record?.complete || !record.agent || !session) return false;
    if (
      checkInFor?.session === session &&
      checkInFor.agent === record.agent &&
      checkInFor.channelId === record.channelId
    )
      return true;
    checkInFor = { session, agent: record.agent, channelId: record.channelId };
    checkIn = undefined;
    void loadCheckIn();
    return true;
  }
  const showCheckIn = (next: CheckIn) => {
    checkIn = next;
    publish(state);
  };
  /** Reads Bestie's check-in from the relay, keeping any problem shown. */
  async function loadCheckIn(problem?: string) {
    const target = checkInFor;
    if (!target) return;
    checkInOperation?.abort();
    const controller = new AbortController();
    checkInOperation = controller;
    const current = () =>
      !disposed && !controller.signal.aborted && checkInFor === target;
    checkIn = { ...checkIn, pending: true, problem };
    try {
      const on = await readCheckIn(
        target.session,
        target.agent,
        target.channelId,
        controller.signal,
      );
      if (current()) showCheckIn({ on, pending: false, problem });
    } catch (error) {
      // The switch keeps the last state the relay gave.
      if (current())
        showCheckIn({
          ...(checkIn?.on !== undefined ? { on: checkIn.on } : {}),
          pending: false,
          problem: [
            problem,
            `Bestie's check-in could not be read. ${explain(error)}`,
          ]
            .filter(Boolean)
            .join(" "),
        });
    } finally {
      if (checkInOperation === controller) checkInOperation = undefined;
    }
  }
  function scope() {
    const connection = relay.snapshot();
    const { viewer, origin } = connection;
    if (connection.status !== "ready" || !viewer || !origin) return;
    return {
      connection,
      owner: viewer,
      key: `buzz.remote-bestie.v2:${JSON.stringify([origin, viewer])}`,
    };
  }
  function refresh() {
    if (disposed || work) return;
    try {
      const current = scope();
      if (!current) {
        publish({
          status: "unavailable",
          message: "Sign in to Buzz and choose a community to set up Bestie.",
        });
        return;
      }
      const inventory = agents.snapshot();
      if (inventory.status !== "ready") {
        publish({
          status: inventory.status === "error" ? "error" : "unavailable",
          message:
            inventory.status === "error"
              ? (inventory.error ?? "Your agents could not be loaded.")
              : "Loading your agents…",
        });
        return;
      }
      const record = read(current.key, current.owner);
      publish({
        status: record?.complete ? "ready" : "idle",
        message: record?.complete
          ? "Your Bestie is set up."
          : "Set up Bestie in this community.",
        record,
        connection: current.connection,
        instructionsChanged: !!record?.complete && changed(record),
      });
    } catch (error) {
      publish({ status: "error", message: explain(error) });
    }
  }
  const stopRelay = relay.subscribe(() => {
    if (relay.snapshot().session !== state.connection?.session) {
      // A new connection invalidates setup in flight; its retry starts afresh.
      operation?.abort();
      held = false;
    }
    // Check-in work belongs to its own connection, which a state without
    // one (agents still loading, say) hasn't replaced.
    if (checkInFor && relay.snapshot().session !== checkInFor.session)
      checkInOperation?.abort();
    if (!held) refresh();
  });
  const stopAgents = agents.subscribe(() => {
    if (!held) refresh();
  });
  refresh();

  async function provision(signal: AbortSignal, options: SetupOptions = {}) {
    const context = scope();
    if (!context) throw new Error("Connect to a community first.");
    const { key, owner, connection } = context;
    const session = connection.session;
    const active = () =>
      !disposed && !signal.aborted && relay.snapshot().session === session;
    const check = () => {
      signal.throwIfAborted();
      if (!active())
        throw new DOMException("Account or community changed.", "AbortError");
    };
    const saved = read(key, owner);
    const record: Record = saved ?? {
      version: 1,
      owner,
      channelId: crypto.randomUUID(),
    };
    const save = () => localStorage.setItem(key, JSON.stringify(record));
    const progress = (message: string) => {
      check();
      publish({
        status: "busy",
        message,
        record,
        connection,
        // A failure keeps offering the update it interrupted.
        instructionsChanged: !!record.complete && changed(record),
      });
    };
    /** Stops for the owner to choose Bestie's model from Builderlab's
     * catalog; choosing resumes this same request. */
    const askForModel = async (message: string) => {
      const models = await builderlab.agents.modelCatalog(signal);
      check();
      if (!models.length)
        throw new Error(
          "Builderlab has no models available for Bestie. Retry setup later.",
        );
      held = true;
      publish({
        status: "choose-model",
        message,
        models,
        record,
        connection,
      });
    };
    save();

    progress("Signing in to Builderlab…");
    try {
      await builderlab.session.ensureSignedIn(signal);
    } catch (error) {
      check();
      throw new Error(
        `Sign in to Builderlab to set up Bestie. ${explain(error)}`,
      );
    }
    check();

    if (agents.snapshot().status !== "ready")
      throw new Error("Your agents are still loading. Retry in a moment.");
    const credential = builderlab.session.credential();
    const remoteAgents = async () => {
      const rows = await builderlab.agents.list(signal);
      check();
      if (builderlab.session.credential() !== credential)
        throw new DOMException("Builderlab session changed.", "AbortError");
      return rows;
    };
    // Builderlab says which agents exist; Agents says which are listed in
    // this community, and may still be reading that list after a reconnect.
    let remote = await remoteAgents();
    // Builderlab allows one Bestie per owner and its type says which agent
    // that is; Agents says only whether it is listed in this community.
    const existing = remote.find(
      (row) =>
        row.agentType === "AGENT_TYPE_BESTIE" && row.status !== "Revoked",
    );
    if (record.agent && record.agent !== existing?.pubkey) {
      // The saved Bestie left this account. Start again with a fresh home
      // and instructions; the old home keeps its conversation.
      record.agent = undefined;
      record.promptVersion = undefined;
      record.channelId = crypto.randomUUID();
      record.channelOperation = undefined;
      record.channelFailed = undefined;
      record.welcomeId = undefined;
      record.welcomeFailed = undefined;
      record.complete = undefined;
      save();
    }
    let agent = record.agent ? agents.find(record.agent) : undefined;
    if (record.agent) {
      if (agent && agent.place !== "hosted")
        throw new Error(
          "Your saved Bestie no longer runs on Builderlab. Review Agents before retrying.",
        );
    } else if (existing && agents.find(existing.pubkey)?.unfinished) {
      // This device's own creation, made for this record's home.
      agent = agents.find(existing.pubkey);
      record.agent = existing.pubkey;
      save();
    } else if (existing?.status === "Active") {
      // A set-up Bestie keeps the home its instructions name. Resume it
      // only when that home is in this community; another community's
      // home must not be rewritten.
      const home = existing.instructions
        ? bestieHome(existing.instructions)
        : undefined;
      if (home)
        await session.channels.resolve?.([home], { fresh: true, signal });
      check();
      if (
        !home ||
        !session.channels.list().channels.some((row) => row.id === home)
      )
        throw new Error(
          "Your Bestie already lives in another community. Open Bestie there: a Builderlab account has one Bestie.",
        );
      record.agent = existing.pubkey;
      record.channelId = home;
      record.promptVersion = promptVersion(existing.instructions ?? "");
      // It was introduced and its check-in chosen where it was set up.
      record.complete = true;
      save();
    } else {
      // An unfinished Bestie Agents doesn't list is left to registration,
      // which replays this device's own request, as when its response was
      // lost, or explains Builderlab's refusal of a second one.

      // Agents resumes an unfinished agent of the same name rather than
      // making another, and this one has left the account.
      if (
        agents
          .snapshot()
          .agents.some(
            (row) =>
              row.type === BUILDERLAB_TYPE &&
              row.name === NAME &&
              row.owner === owner &&
              row.unfinished,
          )
      )
        throw new Error(
          "An unfinished Bestie that this Builderlab account no longer has is still in Agents. Delete it in Agents, then create a new Bestie.",
        );
      if (!options.model) {
        await askForModel(
          "Choose the model and reasoning effort Bestie runs on.",
        );
        return;
      }
      progress("Creating Bestie…");
      const instructions = bestieInstructions(owner, record.channelId);
      // A failure after Builderlab made the agent leaves it unfinished in
      // Agents; the next attempt finds and finishes it instead.
      agent = await agents.create({
        type: BUILDERLAB_TYPE,
        name: NAME,
        picture: randomAgentAvatar().url,
        config: {
          instructions,
          ...options.model,
          subject: credential.account.subject,
          agentType: "AGENT_TYPE_BESTIE",
        },
      });
      // Finishing gave this agent its instructions with its model.
      if (!agent.unfinished) record.promptVersion = promptVersion(instructions);
      record.agent = agent.pubkey;
      save();
      check();
      remote = await remoteAgents();
    }
    if (agent?.unfinished) {
      progress("Finishing Bestie's setup…");
      await agents.finish(agent.pubkey);
      check();
      remote = await remoteAgents();
    }
    const pubkey = record.agent;
    if (!pubkey) throw new Error("Bestie could not be found. Retry setup.");
    const listed = remote.find((item) => item.pubkey === pubkey);
    // Builderlab runs an agent only on a valid model choice. An older
    // server reports no status, and its agents run on its default.
    if (
      listed?.modelSelectionStatus &&
      listed.modelSelectionStatus !== "valid"
    ) {
      if (!options.model) {
        await askForModel(
          "Bestie needs a model and reasoning effort before it can reply. Choose one to continue.",
        );
        return;
      }
      progress("Choosing Bestie's model…");
      await builderlab.agents.updateModel(
        listed,
        options.model.modelId,
        options.model.reasoningEffort,
        signal,
      );
      check();
    }

    const instructions = bestieInstructions(owner, record.channelId);
    if (instructions.length > MAX_INSTRUCTIONS_LENGTH)
      throw new Error(
        `Bestie's instructions are ${instructions.length} characters; Builderlab allows ${MAX_INSTRUCTIONS_LENGTH}. Shorten prompt.ts and retry.`,
      );
    if (record.promptVersion !== promptVersion(instructions)) {
      progress("Updating Bestie's instructions…");
      const row = remote.find((item) => item.pubkey === pubkey);
      if (!row)
        throw new Error(
          "Sign in to the Builderlab account that created Bestie, then retry setup.",
        );
      await builderlab.agents.updateInstructions(row, instructions, signal);
      check();
      record.promptVersion = promptVersion(instructions);
      save();
    }

    progress("Opening your private Bestie channel…");
    const outbox = session.outbox;
    if (!outbox) throw new Error("This community cannot save Bestie setup.");
    await outbox.ready();
    check();
    const verifyHome = async () => {
      const home = await session.channelWrites.refreshMembership(
        record.channelId,
      );
      check();
      if (
        home.channelType !== "solo" ||
        home.visibility !== "private" ||
        home.archived ||
        !home.members?.includes(owner) ||
        home.members.some((member) => member !== owner && member !== pubkey)
      )
        throw new Error(
          "Bestie's channel must be private and contain only you and Bestie. Review its members before continuing.",
        );
      return home;
    };
    async function recoverMissing(
      field: "channelOperation" | "welcomeId",
      failed: "channelFailed" | "welcomeFailed",
    ) {
      const id = record[field];
      if (!id || outbox?.snapshot().some((item) => item.event.id === id))
        return;
      // The journal lacks the intent: it was delivered, dismissed after a
      // definite failure, or lost with the app before its own save
      // committed, since the checkpoint is saved as soon as the intent is
      // queued. Strong readback keeps an effect that reached the relay;
      // only one the relay never saw is replaced.
      const events = await session.read(
        [{ ids: [id], limit: 1, consistency: "strong" }],
        { fresh: true, signal },
      );
      check();
      if (!events.some((event) => event.id === id)) {
        record[field] = undefined;
        record[failed] = undefined;
        save();
      }
    }
    async function delivered(
      field: "channelOperation" | "welcomeId",
      failed: "channelFailed" | "welcomeFailed",
    ) {
      const id = record[field];
      if (!id) return;
      // A retry may reach the relay even when an earlier attempt was rejected.
      // Retire the old classification before starting a new delivery attempt.
      record[failed] = undefined;
      save();
      try {
        await session.channelWrites.delivered(id, active);
      } catch (error) {
        record[failed] = session.channelWrites.failed(id) || undefined;
        save();
        throw error;
      }
      check();
    }
    await session.channels.resolve?.([record.channelId], {
      fresh: true,
      signal,
    });
    check();
    const channel = () =>
      session.channels
        .list()
        .channels.find((row) => row.id === record.channelId);
    if (!channel()) {
      await recoverMissing("channelOperation", "channelFailed");
      record.channelOperation ??= outbox
        .snapshot()
        .find(
          (item) =>
            item.event.kind === 9007 &&
            item.event.tags.some(
              ([name, value]) => name === "h" && value === record.channelId,
            ),
        )?.event.id;
      // A named Solo chat: KGoose gives Bestie one session there with recent
      // history, and the relay adds Bestie in the create.
      record.channelOperation ??= session.channelWrites.create(
        record.channelId,
        NAME,
        undefined,
        true,
        [pubkey],
      );
      save();
      await delivered("channelOperation", "channelFailed");
      await session.channelWrites.refresh(
        record.channelId,
        { member: owner },
        false,
      );
      check();
    }
    const home = await verifyHome();
    if (!home.members?.includes(pubkey)) {
      progress("Inviting Bestie to the channel…");
      // Agents join a Solo chat through the agent path, not member additions.
      // That path admits only listed agents, so read the new listing first.
      await session.agentChoices.refresh(true, { fresh: true });
      check();
      await session.channelWrites.addAgents(record.channelId, [pubkey], active);
      check();
    }
    const confirmed = await verifyHome();
    if (!confirmed.members?.includes(pubkey))
      throw new Error(
        "Bestie's invitation has not been confirmed. Retry setup.",
      );

    // A completed setup was introduced already; a resumed one was
    // introduced on the device that set it up.
    if (!record.complete) {
      await recoverMissing("welcomeId", "welcomeFailed");
      record.welcomeId ??= outbox
        .snapshot()
        .find(
          (item) => item.recovery?.key === `bestie-welcome:${record.channelId}`,
        )?.event.id;
      if (!record.welcomeId) {
        record.welcomeId = session.messages.send(
          record.channelId,
          "🤖 Sent by Bestie setup: @Bestie, introduce yourself and help me get started with Buzz.",
          [pubkey],
          [],
          { key: `bestie-welcome:${record.channelId}`, value: pubkey },
        );
        save();
      }
      await delivered("welcomeId", "welcomeFailed");
    }
    // Finishing setup turns check-in on once; after that, the switch on the
    // ready page owns it, including retrying a failed attempt.
    const finishing = !record.complete;
    let checkInProblem: string | undefined;
    if (finishing) {
      progress("Turning on Bestie's hourly check-in…");
      const row = remote.find((item) => item.pubkey === pubkey);
      try {
        if (!row)
          throw new Error(
            "Sign in to the Builderlab account that created Bestie, then retry setup.",
          );
        // Beekeeper names a community by its relay URL; origins are https.
        const community = `wss://${new URL(connection.origin ?? "").host}`;
        await enableCheckIn(
          builderlab.agents,
          row,
          community,
          record.channelId,
          signal,
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          throw error;
        // Bestie still answers mentions without its check-in.
        checkInProblem =
          error instanceof Error
            ? error.message
            : "Bestie's check-in could not be turned on.";
      }
      check();
    }
    record.complete = true;
    save();
    if (finishing) {
      // The relay says whether check-in is on; the ready page shows any
      // problem turning it on alongside.
      checkInFor = { session, agent: pubkey, channelId: record.channelId };
      checkIn = undefined;
      void loadCheckIn(checkInProblem);
    }
    publish({
      status: "ready",
      message: "Your Bestie is set up.",
      record,
      connection,
    });
  }
  /** Turns check-in on or off directly, without re-running the rest of
   * setup, then reads the result back from the relay. The ready page's
   * switch is its only caller, including the retry after a failed attempt. */
  async function setCheckIn(on: boolean) {
    const context = scope();
    if (!context) throw new Error("Connect to a community first.");
    const { key, owner, connection } = context;
    const saved = read(key, owner);
    if (!saved?.complete || !saved.agent)
      throw new Error("Finish Bestie setup before changing check-in.");
    const target = checkInFor;
    if (
      target?.session !== connection.session ||
      target.agent !== saved.agent ||
      target.channelId !== saved.channelId
    )
      throw new Error("Bestie's check-in is still loading.");
    checkInOperation?.abort();
    const controller = new AbortController();
    checkInOperation = controller;
    const { signal } = controller;
    const active = () =>
      !disposed &&
      !signal.aborted &&
      checkInFor === target &&
      relay.snapshot().session === target.session;
    const check = () => {
      if (!active())
        throw new DOMException("Account or community changed.", "AbortError");
    };
    showCheckIn({ ...checkIn, pending: true, problem: undefined });
    let problem: string | undefined;
    try {
      await builderlab.session.ensureSignedIn(signal);
      check();
      const rows = await builderlab.agents.list(signal);
      check();
      const row = rows.find((item) => item.pubkey === saved.agent);
      if (!row)
        throw new Error(
          "Sign in to the Builderlab account that created Bestie, then retry.",
        );
      // Beekeeper names a community by its relay URL; origins are https.
      const community = `wss://${new URL(connection.origin ?? "").host}`;
      if (on)
        await enableCheckIn(
          builderlab.agents,
          row,
          community,
          saved.channelId,
          signal,
        );
      else await disableCheckIn(builderlab.agents, row, community, signal);
    } catch (error) {
      // Only this change being replaced, or its connection, is silent; a
      // Builderlab sign-out mid-change is a problem to show.
      if (!active()) return;
      problem = explain(error);
    } finally {
      if (checkInOperation === controller) checkInOperation = undefined;
    }
    // Even a failed change may have reached the relay.
    if (active()) await loadCheckIn(problem);
  }
  function run(options?: SetupOptions) {
    if (disposed) return Promise.resolve();
    if (work) return work;
    const controller = new AbortController();
    operation = controller;
    held = false;
    const task = async () => {
      const current = scope();
      if (!current) throw new Error("Connect to a community first.");
      // One setup per owner and community across this app's windows.
      if (typeof navigator !== "undefined" && navigator.locks)
        await navigator.locks.request(
          current.key,
          { signal: controller.signal },
          () => provision(controller.signal, options),
        );
      else await provision(controller.signal, options);
    };
    work = task()
      .catch((error: unknown) => {
        if (disposed || controller.signal.aborted) return;
        held = true;
        publish({
          ...state,
          status: "error",
          message: explain(error),
        });
      })
      .finally(() => {
        if (operation === controller) operation = undefined;
        work = undefined;
        // An aborted attempt reports the state it left behind.
        if (controller.signal.aborted) refresh();
      });
    return work;
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setup: () => run(),
    setCheckIn,
    /** Resumes the setup that stopped for a model choice. */
    chooseModel(model: ModelChoice) {
      return run({ model });
    },
    dispose() {
      disposed = true;
      operation?.abort();
      checkInOperation?.abort();
      stopRelay();
      stopAgents();
      listeners.clear();
    },
  };
}
export type RemoteBestie = ReturnType<typeof createRemoteBestie>;
