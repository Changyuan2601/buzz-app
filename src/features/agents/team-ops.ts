// Team changes through the relay: one saved record per change, run by one
// queue per team. Each dispatch also re-reads its record, since Discard,
// Dismiss and revise act outside a step. A record holds at most one signed
// revision whose outcome is unknown, and member and lifecycle commands persisted before they are sent.
// Nothing whose outcome is unknown is sent again automatically; only a fresh
// read resolves it. Dormant until config sync ships.
import { PublishRejected } from "../relay/outbox";
import type { RelayEvent } from "../relay/events";
import type { RelayWriter } from "../relay/transport";
import {
  ARTIFACT_KIND,
  artifactD,
  artifactTemplate,
  checkedHead,
  deliver,
  type Expected,
  readHead,
  type SnapshotRead,
} from "./agent-config-artifacts";
import {
  agentSubject,
  type ConfigChannels,
  teamSubject,
} from "./config-channels";
import type { AgentConfigStore } from "./agent-config";
import type { ConfigSync } from "./config-sync";
import { carried, edited } from "./config-writes";
import { teamBody } from "./team-config";

export const TEAM_OPS_KEY = "buzz.agents.teams.ops.v1";
/** Ceilings per owner and community, not reserved space: one scope can't
 * consume another's logical allowance; physical storage is shared. */
export const OPS_RECORD_LIMIT = 20;
export const OPS_BYTE_LIMIT = 1.5 * 1024 * 1024;
export const STORAGE_FULL = "This device's storage is full";

export type TeamIntent = Readonly<{
  name: string;
  instructions: string;
  members: readonly string[];
}>;
export type OpKind =
  | "create"
  | "edit"
  | "import"
  | "move"
  | "delete"
  | "recover";
export type CommandState = "planned" | "maybe-sent" | "confirmed" | "refused";
export type Command = Readonly<{
  action: "add" | "remove" | "archive" | "unarchive";
  pubkey?: string;
  state: CommandState;
  error?: string;
}>;
/** The one signed revision held for this record. `sends` counts deliveries
 * started, persisted before each, so only a known first attempt's refusal is
 * final. `accepted`: proven stored, but not yet seen current. */
export type Candidate = Readonly<{
  event: RelayEvent;
  sends: number;
  accepted?: true;
}>;
export type Stop = "conflict" | "discarded" | "archived" | "deleted" | "scope";
export type TeamOp = Readonly<{
  id: string;
  owner: string;
  community: string;
  teamId: string;
  /** The team config channel, once selected or made. */
  channel?: string;
  kind: OpKind;
  /** An Import's old Buzz team, or a move's local team (its local row). */
  source?: Readonly<{ kind: "old-buzz-team" | "local-team"; id: string }>;
  /** A move's local row, removed once the move is done. */
  local?: string;
  /** The latest submitted snapshot, never unsaved edits. */
  intent: TeamIntent;
  /** The head the form opened (`null`: none). Import and move: unset until
   * decided, then the adopted head, pinned, or `null` when they create. */
  base?: string | null;
  /** Our own head proven current; for an adopted team, the adopted head. */
  confirmedHead?: string;
  candidate?: Candidate;
  /** Our revision the relay proved it stored, superseded since. */
  accepted?: string;
  commands: readonly Command[];
  mode: "may-send" | "reconcile-only";
  stop?: Stop;
  error?: string;
  /** Submission order, for resuming oldest first. */
  seq: number;
}>;

const encoder = new TextEncoder();
const size = (op: TeamOp) => encoder.encode(JSON.stringify(op)).length;
const scopeOf = (op: Pick<TeamOp, "owner" | "community">) =>
  `${op.owner}\n${op.community}`;

/** Every unfinished team change on this device. A write that fails leaves
 * memory as storage has it. */
export class TeamOps {
  private records: Record<string, TeamOp> = {};
  constructor(private readonly storage: Storage = localStorage) {
    try {
      const value = JSON.parse(storage.getItem(TEAM_OPS_KEY) ?? "null") as {
        version?: unknown;
        records?: unknown;
      } | null;
      if (
        value?.version === 1 &&
        value.records &&
        typeof value.records === "object"
      )
        this.records = value.records as Record<string, TeamOp>;
    } catch {
      /* Start fresh after malformed local data. */
    }
  }
  get = (id: string): TeamOp | undefined => this.records[id];
  all = (owner: string, community: string) =>
    Object.values(this.records)
      .filter((op) => op.owner === owner && op.community === community)
      .sort((a, b) => a.seq - b.seq);
  every = () => Object.values(this.records);
  nextSeq = () =>
    Math.max(0, ...Object.values(this.records).map((op) => op.seq)) + 1;
  /** Stores `changes` (undefined removes) in one write. A scope may not grow
   * past its ceilings; shrinking or settling a record always fits. Throws
   * `STORAGE_FULL` and changes nothing when it doesn't fit. */
  write(changes: Readonly<Record<string, TeamOp | undefined>>) {
    const next = { ...this.records };
    for (const [id, op] of Object.entries(changes))
      if (op) next[id] = op;
      else delete next[id];
    const measure = (records: Record<string, TeamOp>, scope: string) => {
      const mine = Object.values(records).filter((op) => scopeOf(op) === scope);
      return {
        count: mine.length,
        bytes: mine.reduce((n, op) => n + size(op), 0),
      };
    };
    const scopes = new Set(
      [...Object.keys(changes)].flatMap((id) => {
        const op = next[id] ?? this.records[id];
        return op ? [scopeOf(op)] : [];
      }),
    );
    for (const scope of scopes) {
      const before = measure(this.records, scope);
      const after = measure(next, scope);
      if (
        (after.count > OPS_RECORD_LIMIT && after.count > before.count) ||
        (after.bytes > OPS_BYTE_LIMIT && after.bytes > before.bytes)
      )
        throw new Error(STORAGE_FULL);
    }
    try {
      this.storage.setItem(
        TEAM_OPS_KEY,
        JSON.stringify({ version: 1, records: next }),
      );
    } catch (cause) {
      throw new Error(STORAGE_FULL, { cause });
    }
    this.records = next;
  }
}

/** Whether a record still holds something whose outcome is unknown. */
export const unresolved = (op: TeamOp) =>
  !!op.candidate || op.commands.some((c) => c.state === "maybe-sent");

/** Whether a move or import has its relay team: adopted, or our create
 * proven current. A pending or refused create is not established. */
export const established = (op: TeamOp) => op.confirmedHead !== undefined;

const STOPPED: Record<Stop, string> = {
  conflict:
    "This team changed on another device. Resubmit or dismiss your change.",
  discarded: "This change was discarded.",
  archived: "This team was deleted, so this change stopped.",
  deleted: "A delete of this team stopped this change.",
  scope: "This team's channel changed, so this change stopped.",
};

/** What keeps an unfinished change from being done, for the owner. */
export function teamOpProblem(op: TeamOp) {
  const unknown = unresolved(op)
    ? " Some steps may have been saved; Check again confirms them."
    : "";
  if (op.stop) return STOPPED[op.stop] + unknown;
  if (unknown) return unknown.trim();
  return (
    op.error ??
    "This change hasn't finished yet; it continues when the community is reachable."
  );
}

export type RunnerDeps = Readonly<{
  read: SnapshotRead;
  writer: RelayWriter;
  maxEventBytes: number;
  signal: AbortSignal;
  channels: Pick<
    ConfigChannels,
    | "find"
    | "ensure"
    | "archive"
    | "unarchive"
    | "archived"
    | "addMember"
    | "removeMember"
    | "owns"
  >;
  sync: Pick<ConfigSync, "bind">;
  /** Where each head a step reads is installed, so starts use it at once. */
  store: Pick<AgentConfigStore, "capture" | "applyRead">;
  ops: TeamOps;
  owner: string;
  community: string;
  /** A record is about to be removed: finished, dismissed or replaced.
   * Whatever it alone still holds is committed here; throwing keeps it. */
  done(op: TeamOp): void;
  /** Records changed, so the owner's view re-reads them. */
  changed(): void;
}>;

const LIFECYCLE: Partial<Record<OpKind, "archive" | "unarchive">> = {
  delete: "archive",
  recover: "unarchive",
};

export function teamRunner(deps: RunnerDeps) {
  const { ops, channels, signal } = deps;
  const tails = new Map<string, Promise<unknown>>();

  const mine = () => ops.all(deps.owner, deps.community);
  const onTeam = (teamId: string) =>
    mine().filter((op) => op.teamId === teamId);
  /** An unknown outcome on the team, in a record other than `except`. */
  const fenced = (teamId: string, except: string) =>
    onTeam(teamId).some((op) => op.id !== except && unresolved(op));

  /** Runs `work` after the team's earlier steps settle: one step per team
   * at a time, so no two overlap across signing, delivery or a command. */
  function queue<T>(teamId: string, work: () => Promise<T>): Promise<T> {
    const tail = tails.get(teamId) ?? Promise.resolve();
    const run = tail.then(work);
    const settled = run.catch(() => {});
    tails.set(teamId, settled);
    void settled.then(() => {
      if (tails.get(teamId) === settled) tails.delete(teamId);
    });
    return run;
  }

  /** Persists `changes` and reports them. */
  function put(changes: Readonly<Record<string, TeamOp | undefined>>) {
    ops.write(changes);
    deps.changed();
  }
  /** Stops automatic sending on records `which` selects, in one write. */
  function stopAll(teamId: string, stop: Stop, which: (op: TeamOp) => boolean) {
    const changes: Record<string, TeamOp> = {};
    for (const op of onTeam(teamId))
      if (op.mode === "may-send" && which(op))
        changes[op.id] = { ...op, mode: "reconcile-only", stop };
    if (Object.keys(changes).length) put(changes);
  }
  /** Seeing an archive stops save and member intent only. A lifecycle record
   * is never auto-stopped: Recover exists to act on an archived team, and
   * its step decides from the metadata it reads, not from `mode`. */
  const intentKinds = (op: TeamOp) => !LIFECYCLE[op.kind];

  /** Stores a new change. A Delete
   * stops every older record on the team in the same write. */
  function submit(
    input: Pick<TeamOp, "kind" | "teamId" | "intent"> &
      Partial<Pick<TeamOp, "base" | "source" | "channel" | "local">>,
  ) {
    const op: TeamOp = {
      id: crypto.randomUUID(),
      owner: deps.owner,
      community: deps.community,
      commands: LIFECYCLE[input.kind]
        ? [{ action: LIFECYCLE[input.kind] as "archive", state: "planned" }]
        : [],
      mode: "may-send",
      seq: ops.nextSeq(),
      ...input,
    };
    const changes: Record<string, TeamOp> = { [op.id]: op };
    if (op.kind === "delete")
      for (const older of onTeam(op.teamId))
        if (older.mode === "may-send")
          changes[older.id] = {
            ...older,
            mode: "reconcile-only",
            stop: "deleted",
          };
    put(changes);
    return op;
  }

  /** One step of record `id`, queued on its team. Resolves with the record
   * as it stands after, or undefined once it is done. */
  function run(id: string) {
    const op = ops.get(id);
    if (!op) return Promise.resolve(undefined);
    return queue(op.teamId, () => step(id));
  }

  async function step(id: string): Promise<TeamOp | undefined> {
    let op = ops.get(id);
    if (!op || op.owner !== deps.owner || op.community !== deps.community)
      return op;
    /** The durable record after an await: a Delete, Discard or Dismiss
     * meanwhile wins over what this step read before. */
    const fresh = () => {
      op = ops.get(id) as TeamOp | undefined;
      return op;
    };
    const save = (next: TeamOp) => {
      put({ [id]: next });
      op = next;
      return next;
    };
    /** The durable record, if it may still send: re-read before every
     * dispatch, so a Delete submitted meanwhile stops the next command. */
    const live = () => {
      const now = ops.get(id);
      return now?.mode === "may-send" ? now : undefined;
    };
    const finish = () => {
      const last = ops.get(id);
      if (!last) return undefined;
      deps.done(last);
      put({ [id]: undefined });
      return undefined;
    };

    // A fresh roster and metadata read of the selected channel.
    const label = await teamSubject(op.teamId);
    let found: Awaited<ReturnType<typeof channels.find>>;
    try {
      found = await channels.find("team-config", label, signal);
    } catch {
      return op;
    }
    if (!fresh()) return undefined;
    if (op.channel && found?.id !== op.channel) {
      // Discovery selects another channel now (or none): never send here.
      if (op.mode === "may-send")
        save({ ...op, mode: "reconcile-only", stop: "scope" });
      return op;
    }
    if (found?.archived) stopAll(op.teamId, "archived", intentKinds);
    op = ops.get(id) as TeamOp;

    if (LIFECYCLE[op.kind]) return lifecycle(op, found?.id, save, live, finish);

    if (!found) {
      if (op.kind === "edit" || !live()) return op;
      try {
        found = await channels.ensure(
          "team-config",
          label,
          op.intent.name,
          signal,
        );
      } catch (error) {
        return fresh() && save({ ...op, error: message(error) });
      }
      if (!fresh() || found.archived) return op;
    }
    const channel = found.id;
    if (op.channel !== channel) save({ ...op, channel });
    if (!found.archived)
      await deps.sync
        .bind([{ family: "team-config", subject: op.teamId, channel }])
        .catch(() => {});
    if (!fresh()) return undefined;

    // Member results resolve from the roster even when the team's record
    // can't be read.
    const roster = found.members && new Set(found.members);
    if (roster) {
      const commands = op.commands.map((c) =>
        c.state !== "confirmed" &&
        c.pubkey &&
        (c.action === "add") === roster.has(c.pubkey)
          ? { action: c.action, pubkey: c.pubkey, state: "confirmed" as const }
          : c,
      );
      if (commands.some((c, i) => c !== op?.commands[i]))
        save({ ...op, commands });
    }

    const expected: Expected = {
      channel,
      type: "buzz.team",
      d: await artifactD("buzz.team", channel),
      team: op.teamId,
    };
    const subject = {
      owner: deps.owner,
      community: deps.community,
      subject: op.teamId,
      channel,
      type: "buzz.team" as const,
    };
    const capture = deps.store.capture(subject);
    let head: RelayEvent | undefined;
    try {
      head = await readHead(deps.read, channel, expected.d, signal);
    } catch {
      return fresh() && settleProof(op, channel, save);
    }
    if (!fresh()) return undefined;
    const checked = head && checkedHead(head, expected);
    if (checked) deps.store.applyRead(subject, capture, checked);
    if (checked?.problem) return settleProof(op, channel, save);
    // An empty read proves nothing about an existing team: only a first
    // create may proceed without a current head.
    if (!head && (op.kind === "edit" || op.base || op.confirmedHead))
      return settleProof(op, channel, save);

    // Our own save is current: confirmed, held bytes dropped, one write.
    if (head && op.candidate?.event.id === head.id) {
      const { candidate: _, error: __, ...rest } = op;
      save({ ...rest, confirmedHead: head.id });
    }
    // A revision proven stored earlier is current now: the same.
    if (head && op.accepted === head.id) {
      const { accepted: _, error: __, ...rest } = op;
      save({ ...rest, confirmedHead: head.id });
    }
    // Import and move adopt a team that already exists, pinning its head:
    // only while they may still send, never an archived team's, so a
    // stopped move is never established by a check.
    if (
      op.base === undefined &&
      head &&
      !op.candidate &&
      op.mode === "may-send" &&
      !found.archived
    )
      save({ ...op, base: head.id, confirmedHead: head.id });
    if (op.base === undefined && !head) save({ ...op, base: null });

    // The gate: the head must be the one we started from or our own.
    if (head && head.id !== op.base && head.id !== op.confirmedHead)
      return conflict(op, channel, save);
    if (op.mode !== "may-send") return op;
    if (fenced(op.teamId, id)) return op;

    if (op.candidate) {
      if (op.candidate.accepted) return op;
      return send(op, save, live, op.candidate.event.id);
    }
    const body = head && teamBody(head.content);
    const adopted =
      op.base !== null && (op.kind === "import" || op.kind === "move");
    const same =
      !!body &&
      body.name === op.intent.name &&
      body.instructions === op.intent.instructions;
    if (!adopted && !same) {
      const content = head
        ? edited(head, {
            version: 1,
            name: op.intent.name,
            instructions: op.intent.instructions,
          })
        : JSON.stringify({
            version: 1,
            name: op.intent.name,
            instructions: op.intent.instructions,
          });
      const own = [
        ["team", op.teamId],
        ...(op.source && !head
          ? [["imported-from", `${op.source.kind}:${op.source.id}`]]
          : []),
      ];
      const event = await deps.writer.sign(
        artifactTemplate({
          ...expected,
          title: op.intent.name,
          content,
          ...(head
            ? { op: "update" as const, prev: head.id }
            : { op: "create" as const }),
          extra: carried(head, own),
        }),
        signal,
      );
      // A revision another step installed while this one signed wins.
      const now = live();
      if (!now || now.candidate) return ops.get(id);
      // Persisted, within budget, before it is sent; else nothing is sent.
      save({ ...now, candidate: { event, sends: 0 } });
      return send(op, save, live, event.id);
    }
    if (head && op.confirmedHead !== head.id)
      save({ ...op, confirmedHead: head.id });
    return members(op, roster, save, live, finish);
  }

  /** Someone else's head: stop, touch no members, keep the draft. Proof
   * that our held revision was stored ends its uncertainty. */
  async function conflict(
    op: TeamOp,
    channel: string,
    save: (next: TeamOp) => TeamOp,
  ) {
    // A record removed or replaced meanwhile ends here.
    const now = await settleProof(op, channel, save);
    if (!now) return undefined;
    return save({
      ...now,
      mode: "reconcile-only",
      stop: now.stop ?? "conflict",
    });
  }

  /** Ends a held revision's uncertainty from proof it was stored, the
   * relay's acceptance or a by-id read, apart from whether the head can be
   * read. Grants no currency: `accepted`, never `confirmedHead`. */
  async function settleProof(
    op: TeamOp,
    channel: string,
    save: (next: TeamOp) => TeamOp,
  ) {
    const held = op.candidate;
    if (!held) return op;
    const proven =
      held.accepted ||
      (await stored(held.event.id, channel).catch(() => false));
    const now = ops.get(op.id);
    if (!proven || now?.candidate?.event.id !== held.event.id) return now;
    const { candidate: _, ...rest } = now;
    return save({ ...rest, accepted: held.event.id });
  }

  /** A relay-only lookup of one revision by id. */
  async function stored(eventId: string, channel: string) {
    const events = await deps.read(
      [
        {
          ids: [eventId],
          kinds: [ARTIFACT_KIND],
          "#h": [channel],
          limit: 1,
          consistency: "strong",
        },
      ],
      { signal },
    );
    return events.length === 1 && events[0]?.id === eventId;
  }

  /** Delivers the held revision's identical bytes once. A refusal or an
   * unknown result ends the step. */
  async function send(
    op: TeamOp,
    save: (next: TeamOp) => TeamOp,
    live: () => TeamOp | undefined,
    eventId: string,
  ): Promise<TeamOp | undefined> {
    // Only this step's held revision, and only while the team is unfenced.
    const now = live();
    const held = now?.candidate;
    if (!now || held?.event.id !== eventId || fenced(now.teamId, now.id))
      return ops.get(op.id);
    const sends = held.sends + 1;
    save({ ...now, candidate: { ...held, sends } });
    const sent = await deliver(
      deps.writer,
      held.event,
      signal,
      deps.maxEventBytes,
    );
    // A late reply for a record removed or re-signed meanwhile is dropped.
    const after = ops.get(op.id);
    if (after?.candidate?.event.id !== eventId) return after;
    if (sent.status === "accepted") {
      // Proof it was stored, kept before any read can fail.
      save({ ...after, candidate: { ...held, sends, accepted: true } });
      return step(op.id);
    }
    if (sent.status === "uncertain" || sends > 1)
      return save({ ...after, error: sent.message });
    // A definite refusal of a known first attempt is final for these bytes.
    const { candidate: _, ...rest } = after;
    if (sent.refusal === "rate-limited")
      return save({ ...rest, error: sent.message });
    // An Import or move whose create collided adopts the team that won on
    // its next step, before any member work.
    if (
      sent.refusal === "conflict" &&
      (rest.kind === "import" || rest.kind === "move")
    ) {
      const { base: __, ...open } = rest;
      return save({ ...open, error: sent.message });
    }
    return save({
      ...rest,
      mode: "reconcile-only",
      ...(sent.refusal === "conflict" ? { stop: "conflict" as const } : {}),
      error: sent.message,
    });
  }

  /** Member commands, only once our head passed the gate. */
  async function members(
    start: TeamOp,
    roster: ReadonlySet<string> | undefined,
    save: (next: TeamOp) => TeamOp,
    live: () => TeamOp | undefined,
    finish: () => undefined,
  ): Promise<TeamOp | undefined> {
    if (!roster || !start.channel) return start;
    const channel = start.channel;
    // What this step's roster still lacks for the latest intent. Confirmed
    // history proves nothing about today; unknown outcomes stay as fences.
    const want = new Set(start.intent.members);
    const wanted: Command[] = [];
    for (const pubkey of want)
      if (!roster.has(pubkey))
        wanted.push({ action: "add", pubkey, state: "planned" });
    if (start.kind === "edit")
      for (const pubkey of roster)
        if (
          pubkey !== deps.owner &&
          !want.has(pubkey) &&
          (await channels.owns(pubkey, signal).catch(() => false))
        )
          wanted.push({ action: "remove", pubkey, state: "planned" });
    // A plan holds only for the intent it was built from: a revise while
    // this step waited ends it, and the next step plans afresh.
    const planned = JSON.stringify(start.intent.members);
    const current = () => {
      const now = live();
      return now && JSON.stringify(now.intent.members) === planned
        ? now
        : undefined;
    };
    const now = current();
    if (!now) return ops.get(start.id);
    const same = (a: Command) => (b: Command) =>
      a.action === b.action && a.pubkey === b.pubkey;
    const commands = [
      ...now.commands.filter((c) => c.state === "maybe-sent"),
      ...wanted.flatMap((c) => {
        const was = now.commands.find(same(c));
        if (was?.state === "maybe-sent") return [];
        return [was?.state === "refused" ? was : c];
      }),
    ];
    const plan = save({ ...now, commands });
    if (plan.commands.some((c) => c.state === "maybe-sent")) return plan;
    for (const command of plan.commands) {
      if (command.state === "confirmed" || !command.pubkey) continue;
      const pubkey = command.pubkey;
      if (command.action === "add") {
        // A member joins once its own config channel exists.
        const own = await channels
          .find("agent-config", agentSubject(pubkey), signal)
          .catch(() => undefined);
        if (!own || own.archived) continue;
      }
      // Re-read at dispatch: still this intent, this command still unsent,
      // and no other record on the team left an unknown outcome.
      const now = current();
      const was = now?.commands.find(same(command));
      if (
        !now ||
        !was ||
        was.state === "confirmed" ||
        was.state === "maybe-sent" ||
        fenced(now.teamId, now.id)
      )
        return ops.get(start.id);
      const at = (state: CommandState, error?: string) => {
        const base = ops.get(start.id);
        if (!base) return undefined;
        return save({
          ...base,
          commands: base.commands.map((c) =>
            same(command)(c)
              ? { action: c.action, pubkey, state, ...(error ? { error } : {}) }
              : c,
          ),
        });
      };
      at("maybe-sent");
      const result = await (command.action === "add"
        ? channels.addMember(channel, pubkey, signal)
        : channels.removeMember(channel, pubkey)
      ).catch((error: unknown) => ({
        status: "uncertain" as const,
        error: message(error),
      }));
      if (result.status === "uncertain") return at("maybe-sent", result.error);
      at(result.status === "confirmed" ? "confirmed" : "refused", result.error);
    }
    const last = current();
    return last?.commands.every((c) => c.state === "confirmed")
      ? finish()
      : ops.get(start.id);
  }

  /** Delete and Recover, decided from fresh channel metadata and the team's
   * command fences, never from whether the team's record reads. */
  async function lifecycle(
    op: TeamOp,
    channel: string | undefined,
    save: (next: TeamOp) => TeamOp,
    live: () => TeamOp | undefined,
    finish: () => undefined,
  ): Promise<TeamOp | undefined> {
    if (!channel) return op;
    if (op.channel !== channel) op = save({ ...op, channel });
    const archive = op.kind === "delete";
    const settled = async () => {
      const archived = await channels.archived(channel, signal);
      // Seeing an archive stops older save and member intent.
      if (archived) stopAll(op.teamId, "archived", intentKinds);
      return archived === archive;
    };
    let reached: boolean;
    try {
      reached = await settled();
    } catch {
      return op;
    }
    // An earlier command whose outcome is unknown may still land: neither
    // complete nor dispatch until it resolves.
    if (fenced(op.teamId, op.id)) return ops.get(op.id);
    if (reached) return finish();
    // The command as the durable record holds it now, not as read before.
    const now = live();
    const [command] = now?.commands ?? [];
    if (!now || !command || command.state === "maybe-sent")
      return ops.get(op.id);
    const state = (s: CommandState, error?: string) => {
      const base = ops.get(op.id);
      if (!base) return undefined;
      return save({
        ...base,
        commands: [
          { action: command.action, state: s, ...(error ? { error } : {}) },
        ],
        ...(error ? { error } : {}),
      });
    };
    state("maybe-sent");
    try {
      await channels[archive ? "archive" : "unarchive"](channel, signal);
    } catch (error) {
      if (error instanceof PublishRejected)
        return state("refused", message(error));
      return state("maybe-sent", message(error));
    }
    try {
      if ((await settled()) && !fenced(op.teamId, op.id)) return finish();
    } catch {
      /* Unread: the fence stays. */
    }
    return ops.get(op.id);
  }

  return {
    submit,
    run,
    /** Stores and runs a change. */
    start(input: Parameters<typeof submit>[0]) {
      const op = submit(input);
      return { op, done: run(op.id) };
    },
    /** Runs every record of this scope, oldest first: sending ones and the
     * read-only reconciliation of stopped ones. */
    resume: () =>
      Promise.all(mine().map((op) => run(op.id).catch(() => undefined))),
    records: mine,
    /** A newer submission to a record that may still send: it waits behind
     * any held revision, never replacing its bytes. */
    revise(id: string, intent: TeamIntent) {
      const op = ops.get(id);
      if (op?.mode !== "may-send") return false;
      put({ [id]: { ...op, intent } });
      return true;
    },
    /** Stops automatic sending; the evidence stays for reconciliation. */
    discard(id: string) {
      const op = ops.get(id);
      if (op && op.mode === "may-send")
        put({ [id]: { ...op, mode: "reconcile-only", stop: "discarded" } });
    },
    /** Removes a stopped record; only once nothing in it is unresolved. */
    dismiss(id: string) {
      const op = ops.get(id);
      if (!op) return;
      if (op.mode === "may-send" || unresolved(op))
        throw new Error("This change still has unconfirmed steps");
      deps.done(op);
      put({ [id]: undefined });
    },
    /** A stopped change submitted again from the current head; it waits
     * while anything on the team is unresolved. */
    resubmit(id: string, base: string | null) {
      const old = ops.get(id);
      if (!old || old.mode === "may-send" || LIFECYCLE[old.kind])
        throw new Error("Nothing to resubmit");
      if (unresolved(old))
        throw new Error("This change still has unconfirmed steps");
      // An unestablished move stays a move: it keeps its local row's link
      // and adopts the team again, so the row is never orphaned.
      const move = old.local !== undefined && !established(old);
      const op: TeamOp = {
        id: crypto.randomUUID(),
        owner: old.owner,
        community: old.community,
        teamId: old.teamId,
        kind: move ? old.kind : "edit",
        intent: old.intent,
        ...(move ? { local: old.local } : { base }),
        ...(move && old.source ? { source: old.source } : {}),
        commands: [],
        mode: "may-send",
        seq: ops.nextSeq(),
        ...(old.channel ? { channel: old.channel } : {}),
      };
      if (!move) deps.done(old);
      put({ [old.id]: undefined, [op.id]: op });
      return { op, done: run(op.id) };
    },
  };
}
export type TeamRunner = ReturnType<typeof teamRunner>;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
