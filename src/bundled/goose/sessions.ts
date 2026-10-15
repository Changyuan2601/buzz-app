// One agent's goose sessions: one `goose-acp` process for the agent, and in
// it one ACP session per conversation (a thread, a whole DM, or a channel).
// A quiet conversation's session is closed; its next message opens a new one,
// shown the conversation again. A one-off turn (a watch or timer wake) gets a
// session of its own, closed when it ends. Every session holds one of the
// host's MCP servers, so all goose agents share one pool of them, and the least
// recently used idle session closes to make room. Nothing is saved: sessions
// live as long as the app does.
import {
  GooseProcess,
  type ActivityReceipt,
  type GooseSession,
  type ServeMcp,
  type Settled,
  type Spawn,
  type ToolServer,
} from "./goose";

/** A conversation's session closes after this long without a message. */
export const IDLE_MS = 15 * 60_000;
/** The most MCP servers goose sessions hold at once, below the host's 64 for
 * every plugin, so other plugins keep room. */
export const POOL_LIMIT = 48;
const STOPPED: Settled = { ok: false, error: "goose was stopped" };
const LATE: Settled = { ok: false, error: "goose did not start in time" };

/** A session's hold on one MCP server in the pool. */
type Slot = {
  /** Whether it can be closed to make room: no turn runs in it. */
  idle(): boolean;
  /** Closes the session, and resolves once its server has stopped. */
  evict(): Promise<unknown>;
};

/** The MCP servers every goose agent's sessions hold, least recently used
 * first. One runtime shares one. */
export class ServerPool {
  private readonly slots = new Set<Slot>();
  constructor(private readonly limit = POOL_LIMIT) {}

  get size() {
    return this.slots.size;
  }
  /** Holds a server for `slot`, first closing idle sessions to keep below the
   * limit. Busy ones are never closed, so it can go over. Resolves once the
   * closed sessions' servers have stopped: the host counts them until then. */
  take(slot: Slot) {
    const evicted: Promise<unknown>[] = [];
    while (this.slots.size >= this.limit) {
      const stopped = this.evict();
      if (!stopped) break;
      evicted.push(stopped);
    }
    this.slots.add(slot);
    return Promise.all(evicted);
  }
  /** Marks `slot` as used now. */
  touch(slot: Slot) {
    if (this.slots.delete(slot)) this.slots.add(slot);
  }
  release(slot: Slot) {
    this.slots.delete(slot);
  }
  /** Closes the least recently used idle session, and resolves once its
   * server has stopped; undefined when every session is busy. */
  evict() {
    for (const slot of this.slots)
      if (slot.idle()) {
        this.slots.delete(slot);
        return slot.evict();
      }
    return undefined;
  }
}

/** What a session is opened with. */
export type Launch = Readonly<{
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  /** Added to the process's environment: its model and provider. */
  env: Readonly<Record<string, string | null>>;
  systemPrompt: string;
}>;

export type SessionsOptions = Readonly<{
  spawn: Spawn;
  tools: ToolServer;
  /** Starts a session's MCP server for `tools`. */
  serve: ServeMcp;
  /** The servers all goose agents' sessions hold. */
  pool: ServerPool;
  /** The agent's current settings, for a new session. */
  launch(): Promise<Launch>;
  /** Changes when a setting the process was started with has changed. */
  processFingerprint(): string;
  /** Changes when a setting a session was opened with has changed. */
  fingerprint(): string;
  /** Called when a conversation's session opens or closes. */
  onChange?(): void;
}>;

type Process = {
  goose: GooseProcess;
  cwd: string;
  fingerprint: string;
  /** Sessions opening in it, not yet recorded as anything's. */
  opening: number;
};
type Live = {
  session: GooseSession;
  process: Process;
  fingerprint: string;
  slot: Slot;
  timer?: ReturnType<typeof setTimeout>;
};

export class AgentSessions {
  /** The process new sessions open in. One started with older settings keeps
   * running while a session in it works. */
  private current:
    | { fingerprint: string; ready: Promise<Process>; process?: Process }
    | undefined;
  private readonly live = new Map<string, Live>();
  /** One-off turns running or starting, by label. */
  private readonly once = new Map<string, Live | undefined>();
  private onceCount = 0;
  /** Conversations whose session is opening, and the turn it opened for. */
  private readonly opening = new Map<
    string,
    Promise<{ settled?: Promise<Settled> }>
  >();
  /** created_at of the newest event each conversation's session was shown. */
  private readonly shown = new Map<string, number>();
  /** Conversations that have had a session, whose next new one may have been
   * prompted for the old one. */
  private readonly had = new Set<string>();
  private disposed = false;

  constructor(private readonly options: SessionsOptions) {}

  /** What this conversation's session has been shown. */
  seen(key: string) {
    return this.shown.get(key) ?? 0;
  }
  /** Conversations with a session, and whether each is working. */
  snapshot(): { key: string; busy: boolean; sessionId?: string }[] {
    return [
      ...[...this.live].map(([key, live]) => ({
        key,
        busy: live.session.busy,
        sessionId: live.session.id,
      })),
      ...[...this.once.keys()].map((key) => ({ key, busy: true })),
    ];
  }

  /** Sends `text` into the conversation `key`, and resolves when the session
   * has answered it. `steer` replaces `text` when the session is mid-turn;
   * `fresh` builds it again when the session it was built for was closed;
   * `title` names a session opened for it. Once `signal` aborts, it stops
   * waiting for a session to open, which is then kept for the next message,
   * and sends nothing. */
  async deliver(
    key: string,
    text: string,
    seen: number,
    {
      steer = text,
      fresh,
      title,
      signal,
      ...activity
    }: Readonly<{
      steer?: string;
      fresh?: () => Promise<string>;
      title?: string;
      signal?: AbortSignal;
    }> &
      ActivityReceipt = {},
  ): Promise<Settled> {
    for (;;) {
      if (this.disposed) return STOPPED;
      // A message that arrives while its conversation's session opens uses it.
      const opening = this.opening.get(key);
      if (opening) {
        // The session stays shared; only this message gives up on it.
        try {
          await abortable(
            opening.catch(() => undefined),
            signal,
          );
        } catch {
          return LATE;
        }
        continue;
      }
      const live = this.live.get(key);
      if (!live) break;
      if (!live.session.open || (!live.session.busy && this.stale(live))) {
        this.drop(key, live);
        break;
      }
      this.touch(key, live, seen);
      return this.answer(key, live, live.session.busy ? steer : text, activity);
    }
    // Reserved before anything is awaited, so a message that comes meanwhile
    // waits for this session instead of opening another.
    const starting = (async () => {
      // Perhaps built for a session closed since, which had been shown the rest.
      if (this.had.has(key) && fresh) text = await fresh();
      const live = await this.open(
        key,
        title,
        (live) => this.disposed || this.adopt(key, live),
      );
      if (this.disposed) {
        void this.close(live);
        throw new Error("goose was stopped");
      }
      if (signal?.aborted) return {};
      this.touch(key, live, seen);
      return { settled: this.answer(key, live, text, activity) };
    })();
    this.opening.set(key, starting);
    const opened = () => {
      if (this.opening.get(key) === starting) this.opening.delete(key);
    };
    starting.then(opened, opened);
    try {
      const { settled } = await abortable(starting, signal);
      return settled ? await settled : LATE;
    } catch (error) {
      if (this.disposed) return STOPPED;
      if (signal?.aborted) return LATE;
      console.warn("goose could not start", error);
      return { ok: false, error: `goose could not start: ${message(error)}` };
    }
  }

  /** Runs one turn in a new session, then closes it. `label` names it in the
   * snapshot. It gives up, and stops the turn, once `signal` aborts.
   * `prompt` is asked for the turn's text once the session is open, so a turn
   * that should no longer run by then returns undefined and sends nothing. */
  async runOnce(
    label: string,
    prompt: () => string | undefined | Promise<string | undefined>,
    {
      signal,
      title,
    }: Readonly<{
      signal?: AbortSignal;
      title?: string;
    }> = {},
  ): Promise<Settled> {
    if (this.disposed) return STOPPED;
    const key = `${label} #${++this.onceCount}`;
    this.once.set(key, undefined);
    this.options.onChange?.();
    const opening = this.open(
      key,
      title,
      (live) => this.once.has(key) && this.once.set(key, live),
    );
    let live: Live | undefined;
    try {
      live = await abortable(opening, signal);
      if (this.disposed) return STOPPED;
      const text = await abortable(Promise.resolve(prompt()), signal);
      if (text === undefined || this.disposed) return { ok: true };
      return await abortable(live.session.send(text), signal);
    } catch (error) {
      if (signal?.aborted) return { ok: false, error: message(signal.reason) };
      console.warn("goose could not start a one-off session", error);
      return { ok: false, error: `goose could not start: ${message(error)}` };
    } finally {
      this.once.delete(key);
      // One that opens after the turn was given up is closed once it has.
      if (live) await this.close(live);
      else void opening.then((late) => this.close(late)).catch(() => undefined);
      this.options.onChange?.();
    }
  }

  /** Closes idle sessions opened with old settings; busy ones close when they
   * next fall idle. A process started with old settings stops once nothing
   * runs in it. */
  reconfigure() {
    for (const [key, live] of this.live)
      if (!live.session.busy && this.stale(live)) this.drop(key, live);
    void this.current?.ready
      .then((process) => this.retire(process))
      .catch(() => undefined);
  }

  dispose() {
    this.disposed = true;
    const processes = new Set<Process>();
    for (const [key, live] of this.live) {
      processes.add(live.process);
      this.drop(key, live);
    }
    for (const live of this.once.values())
      if (live) processes.add(live.process);
    for (const process of processes) void process.goose.kill();
    void this.current?.ready
      .then((process) => process.goose.kill())
      .catch(() => undefined);
    this.current = undefined;
  }

  private stale(live: Live) {
    return (
      live.fingerprint !== this.options.fingerprint() ||
      live.process.fingerprint !== this.options.processFingerprint()
    );
  }

  /** Opens a session for `key`, which `use` records as its user's before the
   * process stops counting it as opening. */
  private async open(
    key: string,
    title: string | undefined,
    use: (live: Live) => unknown,
  ): Promise<Live> {
    // Read before `launch` reads the settings, so it never describes newer ones.
    const fingerprint = this.options.fingerprint();
    const launch = await this.options.launch();
    const process = await this.process(launch);
    // A settings save meanwhile must not stop the process under it.
    process.opening++;
    try {
      return await this.openIn(process, key, title, fingerprint, launch, use);
    } finally {
      process.opening--;
      this.retire(process);
    }
  }
  private async openIn(
    process: Process,
    key: string,
    title: string | undefined,
    fingerprint: string,
    launch: Launch,
    use: (live: Live) => unknown,
  ): Promise<Live> {
    const { pool } = this.options;
    // Busy until it is adopted as a conversation's.
    const slot: Slot = { idle: () => false, evict: async () => undefined };
    const room = pool.take(slot);
    const start = () =>
      process.goose.open({
        cwd: process.cwd,
        systemPrompt: launch.systemPrompt,
        ...(title ? { title } : {}),
      });
    let session: GooseSession;
    try {
      await room;
      session = await start().catch(async (error: unknown) => {
        // Other plugins hold servers too: make room once, and try again.
        const room = /too many mcp servers/i.test(message(error))
          ? pool.evict()
          : undefined;
        if (!room) throw error;
        await room;
        return start();
      });
    } catch (error) {
      pool.release(slot);
      throw error;
    }
    const released = () => pool.release(slot);
    void (session.server?.closed ?? Promise.resolve()).then(released, released);
    session.conversation = key;
    const live = { session, process, fingerprint, slot };
    if (fingerprint !== this.options.fingerprint() && !this.disposed) {
      // Settings saved while it opened: it would work with the old ones.
      void this.close(live);
      return this.open(key, title, use);
    }
    use(live);
    return live;
  }

  /** The process for the current settings, started when there is none. */
  private process(launch: Launch): Promise<Process> {
    const fingerprint = this.options.processFingerprint();
    if (this.current?.fingerprint === fingerprint) return this.current.ready;
    const old = this.current;
    const current: NonNullable<typeof this.current> = {
      fingerprint,
      ready: (async (): Promise<Process> => {
        const cwd = await absolute(this.options.spawn, launch.workspace);
        const goose = await GooseProcess.start(this.options.spawn, {
          cwd,
          env: launch.env,
          tools: this.options.tools,
          serve: this.options.serve,
        });
        const process: Process = { goose, cwd, fingerprint, opening: 0 };
        void goose.exited.then(() => {
          if (this.current === current) this.current = undefined;
          for (const [key, live] of this.live)
            if (live.process === process) this.drop(key, live);
        });
        return process;
      })(),
    };
    // A process that failed to start is started again on the next message.
    current.ready.then(
      (process) => {
        current.process = process;
      },
      () => {
        if (this.current === current) this.current = undefined;
      },
    );
    this.current = current;
    void old?.ready
      .then((process) => this.retire(process))
      .catch(() => undefined);
    return current.ready;
  }

  /** Stops `process` unless it is the current process for the current
   * settings, or a session runs or opens in it. */
  private retire(process: Process) {
    const current = this.current?.process === process;
    if (
      current &&
      !this.disposed &&
      process.fingerprint === this.options.processFingerprint()
    )
      return;
    const users = [...this.live.values(), ...this.once.values()];
    if (process.opening || users.some((live) => live?.process === process))
      return;
    if (current) this.current = undefined;
    void process.goose.kill();
  }

  private adopt(key: string, live: Live) {
    this.had.add(key);
    this.live.set(key, live);
    // Not idle while the message it opened for is still on its way to it.
    live.slot.idle = () =>
      !live.session.busy &&
      this.live.get(key) === live &&
      !this.opening.has(key);
    live.slot.evict = async () => {
      this.drop(key, live);
      await live.session.server?.closed;
    };
    this.touch(key, live);
    this.options.onChange?.();
  }
  private async answer(
    key: string,
    live: Live,
    text: string,
    activity: ActivityReceipt,
  ) {
    const settled = await live.session.send(text, activity);
    if (this.live.get(key) === live) {
      this.touch(key, live);
      if (!live.session.busy && this.stale(live)) this.drop(key, live);
    }
    return settled;
  }
  /** Notes what the session has been shown and restarts its idle countdown. */
  private touch(key: string, live: Live, seen?: number) {
    this.options.pool.touch(live.slot);
    clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      if (live.session.busy) this.touch(key, live);
      else if (this.live.get(key) === live) this.drop(key, live);
    }, IDLE_MS);
    if (seen !== undefined)
      this.shown.set(key, Math.max(seen, this.shown.get(key) ?? 0));
  }
  private drop(key: string, live: Live) {
    clearTimeout(live.timer);
    if (this.live.get(key) === live) {
      this.live.delete(key);
      this.shown.delete(key);
      this.options.onChange?.();
    }
    void this.close(live);
  }
  /** Ends `live`'s session, and then its process if that has old settings. */
  private async close(live: Live) {
    await live.process.goose.close(live.session);
    this.retire(live.process);
  }
}

/** `workspace` as an absolute path, which ACP sessions need: the host
 * resolves `~/…` for the process it starts there. */
export async function absolute(spawn: Spawn, workspace: string) {
  if (workspace.startsWith("/")) return workspace;
  let directory = "";
  const process = await spawn("workspace", {
    cwd: workspace,
    onStdout: (data) => {
      directory += data;
    },
  });
  if ((await process.exited) !== 0 || !directory.trim())
    throw new Error(`Could not find the workspace ${workspace}`);
  return directory.trim();
}

/** `work`, or a rejection with `signal`'s reason once it aborts. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
