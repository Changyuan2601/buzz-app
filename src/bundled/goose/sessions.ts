// One agent's goose sessions: one ACP session per conversation (a thread, a
// whole DM, or a channel), in the `goose-acp` process all goose agents share.
// A quiet conversation's session is closed; its next message opens a new one,
// shown the conversation again. A one-off turn (a watch or timer wake) gets a
// session of its own, closed when it ends. Every session holds one of the
// host's MCP servers, so all goose agents share one pool of them, and the least
// recently used idle session closes to make room. Nothing is saved: sessions
// live as long as the app does.
import {
  GooseProcess,
  type ActivityReceipt,
  type Choice,
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

/** The one `goose-acp` every goose agent's sessions open in, started in the
 * home folder when a session first needs it, and again after it exits. One
 * runtime shares one. */
export class SharedProcess {
  private ready: Promise<GooseProcess> | undefined;
  constructor(
    private readonly spawn: Spawn,
    /** Starts a session's MCP server for its agent's tools. */
    private readonly serve: ServeMcp,
  ) {}

  /** The running process. One that failed to start is started again on the
   * next call. */
  get(): Promise<GooseProcess> {
    if (this.ready) return this.ready;
    const ready = (async () =>
      GooseProcess.start(this.spawn, {
        cwd: await absolute(this.spawn, "~"),
        serve: this.serve,
      }))();
    const forget = () => {
      if (this.ready === ready) this.ready = undefined;
    };
    void ready.then((goose) => goose.exited.then(forget), forget);
    this.ready = ready;
    return ready;
  }
  /** Stops it, failing every session in it. */
  stop() {
    const ready = this.ready;
    this.ready = undefined;
    void ready?.then((goose) => goose.kill()).catch(() => undefined);
  }
}

/** What a session is opened with. */
export type Launch = Readonly<{
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  systemPrompt: string;
}>;

export type SessionsOptions = Readonly<{
  spawn: Spawn;
  /** Answers the agent's Buzz tools. */
  tools: ToolServer;
  /** The process all goose agents' sessions open in. */
  process: SharedProcess;
  /** The servers all goose agents' sessions hold. */
  pool: ServerPool;
  /** The agent's current settings, for a new session. */
  launch(): Promise<Launch>;
  /** The agent's provider, model and thinking level now, which each new
   * turn runs on. */
  choice(): Choice;
  /** Changes when a setting a session was opened with has changed. */
  fingerprint(): string;
  /** Called when a conversation's session opens or closes. */
  onChange?(): void;
}>;

type Live = {
  session: GooseSession;
  process: GooseProcess;
  fingerprint: string;
  slot: Slot;
  timer?: ReturnType<typeof setTimeout>;
};

export class AgentSessions {
  /** The latest process its sessions opened in, whose exit drops them. */
  private process: GooseProcess | undefined;
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
   * `title` names a session opened for it; `model`, one of the agent's
   * provider's, is what its turn runs on. Once `signal` aborts, it stops
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
      model,
      ...activity
    }: Readonly<{
      steer?: string;
      fresh?: () => Promise<string>;
      title?: string;
      signal?: AbortSignal;
      model?: string;
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
      return this.answer(
        key,
        live,
        live.session.busy ? steer : text,
        activity,
        model,
      );
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
      return { settled: this.answer(key, live, text, activity, model) };
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
   * next fall idle. */
  reconfigure() {
    for (const [key, live] of this.live)
      if (!live.session.busy && this.stale(live)) this.drop(key, live);
  }

  /** Closes its sessions, ending their turns; the process keeps serving other
   * agents. */
  dispose() {
    this.disposed = true;
    for (const [key, live] of this.live) this.drop(key, live);
    for (const live of this.once.values()) if (live) void this.close(live);
  }

  /** Opened with old settings, or on a thinking level when goose's own is
   * chosen now, which only a new session runs on. */
  private stale(live: Live) {
    return (
      live.fingerprint !== this.options.fingerprint() ||
      Boolean(live.session.effort && !this.options.choice().effort)
    );
  }

  /** Opens a session for `key` in the agent's workspace, which `use` records
   * as its user's. */
  private async open(
    key: string,
    title: string | undefined,
    use: (live: Live) => unknown,
  ): Promise<Live> {
    const { pool, spawn } = this.options;
    // Read before `launch` reads the settings, so it never describes newer ones.
    const fingerprint = this.options.fingerprint();
    const launch = await this.options.launch();
    // Removed meanwhile: a goose started now would outlive it.
    if (this.disposed) throw new Error("goose was stopped");
    const [process, cwd] = await Promise.all([
      this.options.process.get(),
      absolute(spawn, launch.workspace),
    ]);
    if (process !== this.process) {
      this.process = process;
      void process.exited.then(() => {
        for (const [key, live] of this.live)
          if (live.process === process) this.drop(key, live);
      });
    }
    // Busy until it is adopted as a conversation's.
    const slot: Slot = { idle: () => false, evict: async () => undefined };
    const room = pool.take(slot);
    const start = () =>
      process.open({
        cwd,
        systemPrompt: launch.systemPrompt,
        ...(title ? { title } : {}),
        tools: this.options.tools,
        choice: this.options.choice,
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
    model: string | undefined,
  ) {
    const settled = await live.session.send(text, activity, model);
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
  private close(live: Live) {
    return live.process.close(live.session);
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
