import type { Agent, Agents } from "../../features/agents/service";
import { randomAgentAvatar } from "../../features/agents/avatar-packs";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { Builderlab } from "../builderlab/service";
import { bestieInstructions, PROMPT_VERSION } from "./prompt";
import {
  installRhythms,
  rhythmsComplete,
  validRhythms,
  type RhythmInstalls,
} from "./rhythms";

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
  promptVersion?: string;
  welcomeId?: string | undefined;
  welcomeFailed?: boolean | undefined;
  complete?: boolean;
  rhythms?: RhythmInstalls;
};
type State = Readonly<{
  status: "unavailable" | "idle" | "busy" | "choose-agent" | "ready" | "error";
  message: string;
  candidates?: readonly Agent[];
  /** An active Builderlab Bestie exists that this community doesn't list. */
  unlisted?: boolean;
  record?: Record | undefined;
  connection?: RelaySnapshot;
}>;
type SetupOptions = Readonly<{ createNew?: boolean }>;
class UnlistedBestieError extends Error {}
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
    (record.rhythms !== undefined && !validRhythms(record.rhythms)) ||
    [record.channelOperation, record.welcomeId].some(
      (id) => id !== undefined && !HEX.test(id),
    )
  )
    throw new Error(
      "Saved Bestie setup is invalid. Review it before retrying.",
    );
  return record;
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
  /** A setup result (error or choice) that only a retry or reconnect clears. */
  let held = false;
  const listeners = new Set<() => void>();
  const publish = (next: State) => {
    state = next;
    for (const listener of listeners) listener();
  };
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
      const ready = record?.complete && rhythmsComplete(record.rhythms);
      publish({
        status: ready ? "ready" : "idle",
        message: ready
          ? "Your Bestie is set up."
          : record?.complete
            ? "Add Bestie's paused workflows to your private channel."
            : "Set up Bestie in this community.",
        record,
        connection: current.connection,
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
    if (!held) refresh();
  });
  const stopAgents = agents.subscribe(() => {
    if (!held) refresh();
  });
  refresh();

  async function provision(
    signal: AbortSignal,
    selected?: string,
    options: SetupOptions = {},
  ) {
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
      publish({ status: "busy", message, record, connection });
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
    let agent: Agent | undefined;
    if (record.agent) {
      const chosen = record.agent;
      agent = agents.find(chosen);
      if (
        (agent && agent.place !== "hosted") ||
        !remote.some((row) => row.pubkey === chosen && row.status !== "Revoked")
      )
        throw new Error(
          "Your saved Bestie is no longer one of your Builderlab agents. Review Agents before retrying.",
        );
    } else {
      const candidates = agents
        .snapshot()
        .agents.filter(
          (row) =>
            row.type === BUILDERLAB_TYPE &&
            row.name === NAME &&
            row.owner === owner &&
            row.place === "hosted",
        );
      if (selected && !candidates.some((row) => row.pubkey === selected))
        throw new Error("That Bestie is no longer available. Retry setup.");
      if (candidates.length > 1 && !selected) {
        held = true;
        publish({
          status: "choose-agent",
          message:
            "You already have several Besties. Choose one to use for this channel.",
          candidates,
          record,
          connection,
        });
        return;
      }
      agent =
        candidates.find((row) => row.pubkey === selected) ?? candidates[0];
      if (!agent) {
        // Never make a second Bestie because this community's list is unread.
        if (
          !options.createNew &&
          remote.some(
            (row) =>
              row.name === NAME &&
              row.status === "Active" &&
              !agents.find(row.pubkey),
          )
        )
          throw new UnlistedBestieError(
            "Your Builderlab account already has a Bestie that isn't listed in this community yet. Wait for your agents to load, then retry, or create a new Bestie for this community.",
          );
        progress("Creating Bestie…");
        // A failure after Builderlab made the agent leaves it unfinished in
        // Agents; the next attempt finds and finishes it instead.
        agent = await agents.create({
          type: BUILDERLAB_TYPE,
          name: NAME,
          picture: randomAgentAvatar().url,
        });
        remote = await remoteAgents();
      }
      record.agent = agent.pubkey;
      save();
      check();
    }
    if (agent?.unfinished) {
      progress("Finishing Bestie's setup…");
      await agents.finish(agent.pubkey);
      check();
      remote = await remoteAgents();
    }
    const pubkey = record.agent;

    if (!record.promptVersion) {
      progress("Updating Bestie's instructions…");
      const row = remote.find((item) => item.pubkey === pubkey);
      if (!row)
        throw new Error(
          "Sign in to the Builderlab account that created Bestie, then retry setup.",
        );
      await builderlab.agents.updateInstructions(
        row,
        bestieInstructions(owner, record.channelId),
        signal,
      );
      check();
      record.promptVersion = PROMPT_VERSION;
      save();
    }

    progress("Opening your private Bestie channel…");
    const outbox = session.outbox;
    if (!outbox) throw new Error("This community cannot save Bestie setup.");
    await outbox.ready();
    check();
    const verifyHome = async () => {
      const home = await session.workSessions.refreshMembership(
        record.channelId,
      );
      check();
      if (
        home.channelType !== "stream" ||
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
    async function recoverDismissed(
      field: "channelOperation" | "welcomeId",
      failed: "channelFailed" | "welcomeFailed",
    ) {
      const id = record[field];
      if (
        !id ||
        !record[failed] ||
        outbox?.snapshot().some((item) => item.event.id === id)
      )
        return;
      // Only a definitely failed, durably dismissed intent may be replaced.
      // Strong readback still protects an effect that reached the relay.
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
        await session.workSessions.delivered(id, active);
      } catch (error) {
        record[failed] = session.workSessions.failed(id) || undefined;
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
      await recoverDismissed("channelOperation", "channelFailed");
      record.channelOperation ??= outbox
        .snapshot()
        .find(
          (item) =>
            item.event.kind === 9007 &&
            item.event.tags.some(
              ([name, value]) => name === "h" && value === record.channelId,
            ),
        )?.event.id;
      record.channelOperation ??= session.workSessions.createChannel(
        record.channelId,
        NAME,
        "private",
      );
      save();
      await delivered("channelOperation", "channelFailed");
      await session.workSessions.refresh(
        record.channelId,
        { member: owner },
        false,
      );
      check();
    }
    const home = await verifyHome();
    if (!home.members?.includes(pubkey)) {
      progress("Inviting Bestie to the channel…");
      await session.memberAdditions.add(record.channelId, pubkey);
      check();
    }
    const confirmed = await verifyHome();
    if (!confirmed.members?.includes(pubkey))
      throw new Error(
        "Bestie's invitation has not been confirmed. Retry setup.",
      );

    await recoverDismissed("welcomeId", "welcomeFailed");
    record.welcomeId ??= outbox
      .snapshot()
      .find(
        (item) => item.recovery?.key === `bestie-welcome:${record.channelId}`,
      )?.event.id;
    if (!record.welcomeId) {
      record.welcomeId = session.messages.send(
        record.channelId,
        "🤖 @Bestie Introduce yourself and help me get started with Buzz.",
        [pubkey],
        [],
        { key: `bestie-welcome:${record.channelId}`, value: pubkey },
      );
      save();
    }
    await delivered("welcomeId", "welcomeFailed");
    record.complete = true;
    save();

    progress("Saving Bestie's paused workflows…");
    record.rhythms ??= {};
    await installRhythms({
      session,
      channelId: record.channelId,
      owner,
      agent: pubkey,
      installs: record.rhythms,
      persist: save,
      check,
    });
    check();
    publish({
      status: "ready",
      message: "Your Bestie is set up.",
      record,
      connection,
    });
  }
  function run(selected?: string, options?: SetupOptions) {
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
          () => provision(controller.signal, selected, options),
        );
      else await provision(controller.signal, selected, options);
    };
    work = task()
      .catch((error: unknown) => {
        if (disposed || controller.signal.aborted) return;
        held = true;
        publish({
          ...state,
          status: "error",
          message: explain(error),
          unlisted: error instanceof UnlistedBestieError,
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
    setup: (selected?: string, options?: SetupOptions) =>
      run(selected, options),
    dispose() {
      disposed = true;
      operation?.abort();
      stopRelay();
      stopAgents();
      listeners.clear();
    },
  };
}
export type RemoteBestie = ReturnType<typeof createRemoteBestie>;
