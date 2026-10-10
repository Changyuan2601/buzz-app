// One agent's Claude sessions: one per conversation (a thread, or a whole DM),
// each continuing across messages and app restarts. A conversation in use keeps
// its process; a quiet one is stopped and resumed from its saved session when it
// is next addressed. One spare process, shared by every agent, waits for the
// next new conversation, so that starts without a spawn.
import {
  ClaudeProcess,
  type ClaudeLaunch,
  type Settled,
  type Spawn,
  type ToolServer,
} from "./claude";

/** A conversation's process stops after this long without a message. */
export const IDLE_MS = 15 * 60_000;
/** Saved sessions per agent; the least recently used are forgotten. */
const SAVED_LIMIT = 200;

/** What is saved for one conversation. */
export type SavedSession = Readonly<{
  id: string;
  /** created_at of the newest event this session has been shown. */
  seen: number;
  at: number;
}>;
export type SessionStore = {
  get(key: string): SavedSession | undefined;
  set(key: string, session: SavedSession): void;
  delete(key: string): void;
};

export type SessionsOptions = Readonly<{
  spawn: Spawn;
  /** Where a new conversation looks for a process already started. */
  spare?: Spare;
  store: SessionStore;
  /** How to start a process with the agent's current settings. */
  launch(): Promise<Omit<ClaudeLaunch, "resume" | "sessionId">>;
  /** Changes when a setting that a running process fixed has changed. */
  fingerprint(): string;
  now?(): number;
  newId?(): string;
  /** Called when a conversation's process starts or stops. */
  onChange?(): void;
}>;

type Live = {
  process: ClaudeProcess;
  fingerprint: string;
  used: number;
  timer?: ReturnType<typeof setTimeout>;
};

export class AgentSessions {
  private readonly live = new Map<string, Live>();
  private readonly opening = new Map<string, Promise<Live | undefined>>();
  private disposed = false;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: SessionsOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** What `seen` says this conversation's session has been shown. */
  seen(key: string) {
    return this.options.store.get(key)?.seen ?? 0;
  }
  /** Conversations with a running process, and whether each is working. */
  snapshot() {
    return [...this.live].map(([key, live]) => ({
      key,
      busy: live.process.busy,
    }));
  }

  /** Sends `text` into the conversation `key`, and resolves when the session
   * has answered it. `steer` replaces `text` when the session is mid-turn;
   * `fresh` builds it again for a new session when the saved one is lost. */
  async deliver(
    key: string,
    text: string,
    seen: number,
    {
      steer = text,
      fresh,
    }: Readonly<{ steer?: string; fresh?: () => Promise<string> }> = {},
  ): Promise<Settled> {
    if (this.disposed) return { ok: false, error: "Claude Code was stopped" };
    // A message that arrives while its conversation's process starts uses it.
    // Checked without awaiting first, so the first message opens it at once.
    const opening = this.opening.get(key);
    if (opening) await opening;
    let live = this.live.get(key);
    if (
      live &&
      (!live.process.running ||
        (live.fingerprint !== this.options.fingerprint() && !live.process.busy))
    ) {
      this.drop(key, live);
      live = undefined;
    }
    if (live) {
      this.touch(key, live, seen);
      return this.answer(key, live, live.process.busy ? steer : text);
    }
    const saved = this.options.store.get(key);
    const starting = this.start(saved?.id).catch((error) => {
      console.warn("Claude Code could not start", error);
      return undefined;
    });
    this.opening.set(key, starting);
    live = await starting;
    if (this.opening.get(key) === starting) this.opening.delete(key);
    if (live && !this.disposed) this.adopt(key, live, seen);
    if (!live) return { ok: false, error: "Claude Code could not start" };
    if (this.disposed) {
      void live.process.kill();
      return { ok: false, error: "Claude Code was stopped" };
    }
    const delivered = await this.answer(key, live, text);
    // A saved session that no longer loads starts over rather than failing
    // every message in the conversation, shown the conversation so far.
    if (!delivered.ok && saved && !live.process.started) {
      this.options.store.delete(key);
      this.drop(key, live);
      return this.deliver(key, fresh ? await fresh() : text, seen);
    }
    return delivered;
  }

  /** Stops idle processes started with old settings; busy ones stop when they
   * next fall idle. */
  reconfigure() {
    const fingerprint = this.options.fingerprint();
    for (const [key, live] of this.live)
      if (live.fingerprint !== fingerprint && !live.process.busy)
        this.drop(key, live);
  }

  dispose() {
    this.disposed = true;
    for (const [key, live] of this.live) this.drop(key, live);
  }

  private async start(resume: string | undefined): Promise<Live> {
    // Read before `launch` reads the settings, so it never describes newer ones.
    const fingerprint = this.options.fingerprint();
    const launch = await this.options.launch();
    const process = resume
      ? await ClaudeProcess.start(this.options.spawn, { ...launch, resume })
      : await this.fresh(launch);
    if (fingerprint === this.options.fingerprint() || this.disposed)
      return { process, fingerprint, used: this.now() };
    // Settings saved while it started: it would work with the old ones.
    void process.kill();
    return this.start(resume);
  }
  /** A process for a new session: the spare when it fits, else a new one. */
  private async fresh(launch: Omit<ClaudeLaunch, "resume" | "sessionId">) {
    const spare = await this.options.spare?.take(launch);
    if (spare)
      try {
        await spare.initialize(launch);
        return spare;
      } catch {
        void spare.kill();
      }
    return ClaudeProcess.start(this.options.spawn, {
      ...launch,
      sessionId: this.newId(),
    });
  }
  private adopt(key: string, live: Live, seen: number) {
    live.process.conversation = key;
    this.live.set(key, live);
    this.touch(key, live, seen);
    this.options.onChange?.();
    void live.process.exited.then(() => {
      if (this.live.get(key) === live) this.drop(key, live);
    });
  }
  private async answer(key: string, live: Live, text: string) {
    const settled = await live.process.send(text);
    if (this.live.get(key) === live) {
      this.touch(key, live);
      if (live.fingerprint !== this.options.fingerprint() && !live.process.busy)
        this.drop(key, live);
    }
    return settled;
  }
  /** Saves the session and restarts its idle countdown. */
  private touch(key: string, live: Live, seen?: number) {
    live.used = this.now();
    clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      if (live.process.busy) this.touch(key, live);
      else if (this.live.get(key) === live) this.drop(key, live);
    }, IDLE_MS);
    const id = live.process.sessionId;
    if (!id) return;
    const prior = this.options.store.get(key);
    this.options.store.set(key, {
      id,
      seen: Math.max(seen ?? 0, prior?.id === id ? prior.seen : 0),
      at: live.used,
    });
  }
  private drop(key: string, live: Live) {
    clearTimeout(live.timer);
    if (this.live.get(key) === live) {
      this.live.delete(key);
      this.options.onChange?.();
    }
    void live.process.kill();
  }
}

/** Where a process runs and its model: all a spare is started with. */
type Where = Pick<ClaudeLaunch, "cwd" | "model">;
const place = ({ cwd, model }: Where) => JSON.stringify([cwd, model ?? ""]);

/** One process started ahead of need, for whichever agent next starts a
 * conversation where it runs and with its model. Starting is most of the wait
 * before a new conversation's first reply; giving the process its prompt is not.
 * It follows the latest new conversation, the likeliest place for the next. */
export class Spare {
  private next:
    | { place: string; process: Promise<ClaudeProcess | undefined> }
    | undefined;
  /** Not started again after it failed to start or died, until a conversation
   * asks for one, so a `claude` that cannot run is not started over and over. */
  private stopped = false;
  private disposed = false;

  constructor(
    private readonly spawn: Spawn,
    /** Answers the tool server before any agent has it: it lists the tools. */
    private readonly tools: ToolServer,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Keeps a spare for one of `wheres`: the one there is, when it fits one,
   * else a new one for the first. */
  warm(...wheres: Where[]) {
    const [first] = wheres;
    if (this.disposed || this.stopped || !first) return;
    if (this.next) {
      if (wheres.some((where) => place(where) === this.next?.place)) return;
      this.stop();
    }
    const next = {
      place: place(first),
      process: ClaudeProcess.spawn(this.spawn, {
        ...first,
        sessionId: this.newId(),
        tools: this.tools,
      }).catch((error) => {
        console.warn("Claude Code could not start a spare session", error);
        return undefined;
      }),
    };
    this.next = next;
    void next.process.then(async (process) => {
      await process?.exited;
      if (this.next !== next) return;
      this.next = undefined;
      this.stopped = true;
    });
  }

  /** The spare, when it was started for `where`; a spare for `where` is
   * started next either way. */
  async take(where: Where) {
    const next = this.next;
    this.next = undefined;
    this.stopped = false;
    this.warm(where);
    if (next?.place !== place(where)) {
      void next?.process.then((process) => process?.kill());
      return undefined;
    }
    const process = await next.process;
    if (process?.running) return process;
    void process?.kill();
    return undefined;
  }

  /** Stops the spare until `warm` is called again. */
  stop() {
    const next = this.next;
    this.next = undefined;
    this.stopped = false;
    void next?.process.then((process) => process?.kill());
  }

  dispose() {
    this.disposed = true;
    this.stop();
  }
}

/** Sessions saved in local storage, by agent and then conversation. */
export function localSessions(
  storage: Storage,
  agent: string,
  name = "buzz.claude-code.sessions.v1",
): SessionStore {
  const readAll = (): Record<string, Record<string, SavedSession>> => {
    try {
      const value = JSON.parse(storage.getItem(name) ?? "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };
  const update = (change: (sessions: Record<string, SavedSession>) => void) => {
    const all = readAll();
    const sessions = { ...(all[agent] ?? {}) };
    change(sessions);
    const kept = Object.entries(sessions)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, SAVED_LIMIT);
    all[agent] = Object.fromEntries(kept);
    try {
      storage.setItem(name, JSON.stringify(all));
    } catch (error) {
      console.warn("Claude Code sessions were not saved", error);
    }
  };
  return {
    get: (key) => {
      const saved = readAll()[agent]?.[key];
      return saved && typeof saved.id === "string" ? saved : undefined;
    },
    set: (key, session) =>
      update((sessions) => {
        sessions[key] = session;
      }),
    delete: (key) =>
      update((sessions) => {
        delete sessions[key];
      }),
  };
}
