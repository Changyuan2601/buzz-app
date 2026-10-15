// One agent's goose sessions: one `goose-acp` process for the agent, and in
// it one ACP session per conversation (a thread, a whole DM, or a channel).
// A quiet conversation's session is closed; its next message opens a new one,
// shown the conversation again. A one-off turn (a watch or timer wake) gets a
// session of its own, closed when it ends. Nothing is saved: sessions live as
// long as the app does.
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
/** How long a one-off turn can run before it is given up; Janet's turn
 * deadline. */
export const ONCE_DEADLINE_MS = 5 * 60_000;

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
  /** The agent's current settings, for a new session. */
  launch(): Promise<Launch>;
  /** Changes when a setting the process was started with has changed. */
  processFingerprint(): string;
  /** Changes when a setting a session was opened with has changed. */
  fingerprint(): string;
  /** Called when a conversation's session opens or closes. */
  onChange?(): void;
}>;

type Process = { goose: GooseProcess; cwd: string; fingerprint: string };
type Live = {
  session: GooseSession;
  process: Process;
  fingerprint: string;
  timer?: ReturnType<typeof setTimeout>;
};

export class AgentSessions {
  /** The process new sessions open in. One started with older settings keeps
   * running while a session in it works. */
  private current: { fingerprint: string; ready: Promise<Process> } | undefined;
  private readonly live = new Map<string, Live>();
  /** One-off turns running or starting, by label. */
  private readonly once = new Map<string, Live | undefined>();
  private onceCount = 0;
  private readonly opening = new Map<string, Promise<Live>>();
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
   * `title` names a session opened for it. */
  async deliver(
    key: string,
    text: string,
    seen: number,
    {
      steer = text,
      fresh,
      title,
      ...activity
    }: Readonly<{
      steer?: string;
      fresh?: () => Promise<string>;
      title?: string;
    }> &
      ActivityReceipt = {},
  ): Promise<Settled> {
    if (this.disposed) return { ok: false, error: "goose was stopped" };
    // A message that arrives while its conversation's session opens uses it.
    const opening = this.opening.get(key);
    if (opening) await opening.catch(() => undefined);
    let live = this.live.get(key);
    if (
      live &&
      (!live.session.open || (!live.session.busy && this.stale(live)))
    ) {
      this.drop(key, live);
      live = undefined;
    }
    if (live) {
      this.touch(key, live, seen);
      return this.answer(key, live, live.session.busy ? steer : text, activity);
    }
    // Perhaps built for a session closed since, which had been shown the rest.
    if (this.had.has(key) && fresh) text = await fresh();
    const starting = this.open(key, title);
    this.opening.set(key, starting);
    try {
      live = await starting;
    } catch (error) {
      console.warn("goose could not start", error);
      return { ok: false, error: `goose could not start: ${message(error)}` };
    } finally {
      if (this.opening.get(key) === starting) this.opening.delete(key);
    }
    if (this.disposed) {
      void live.process.goose.close(live.session);
      return { ok: false, error: "goose was stopped" };
    }
    this.adopt(key, live, seen);
    return this.answer(key, live, text, activity);
  }

  /** Runs one turn in a new session, then closes it. `label` names it in the
   * snapshot. It gives up, and stops the turn, after `deadline` ms. `prompt`
   * is asked for the turn's text once the session is open, so a turn that
   * should no longer run by then returns undefined and sends nothing. */
  async runOnce(
    label: string,
    prompt: () => string | undefined | Promise<string | undefined>,
    {
      deadline = ONCE_DEADLINE_MS,
      title,
    }: Readonly<{
      deadline?: number;
      title?: string;
    }> = {},
  ): Promise<Settled> {
    if (this.disposed) return { ok: false, error: "goose was stopped" };
    const key = `${label} #${++this.onceCount}`;
    this.once.set(key, undefined);
    this.options.onChange?.();
    let live: Live | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      live = await this.open(key, title);
      if (this.disposed) return { ok: false, error: "goose was stopped" };
      this.once.set(key, live);
      const text = await prompt();
      if (text === undefined || this.disposed) return { ok: true };
      return await Promise.race([
        live.session.send(text),
        new Promise<Settled>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                ok: false,
                error: `The turn ran past its ${Math.round(deadline / 1000)}s deadline and was stopped`,
              }),
            deadline,
          );
        }),
      ]);
    } catch (error) {
      console.warn("goose could not start a one-off session", error);
      return { ok: false, error: `goose could not start: ${message(error)}` };
    } finally {
      clearTimeout(timer);
      this.once.delete(key);
      if (live) {
        await live.process.goose.close(live.session);
        this.retire(live.process);
      }
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

  private async open(key: string, title?: string): Promise<Live> {
    // Read before `launch` reads the settings, so it never describes newer ones.
    const fingerprint = this.options.fingerprint();
    const launch = await this.options.launch();
    const process = await this.process(launch);
    const session = await process.goose.open({
      cwd: process.cwd,
      systemPrompt: launch.systemPrompt,
      ...(title ? { title } : {}),
    });
    session.conversation = key;
    if (fingerprint === this.options.fingerprint() || this.disposed)
      return { session, process, fingerprint };
    // Settings saved while it opened: it would work with the old ones.
    void process.goose.close(session);
    return this.open(key, title);
  }

  /** The process for the current settings, started when there is none. */
  private process(launch: Launch): Promise<Process> {
    const fingerprint = this.options.processFingerprint();
    if (this.current?.fingerprint === fingerprint) return this.current.ready;
    const old = this.current;
    const current = {
      fingerprint,
      ready: (async (): Promise<Process> => {
        const cwd = await absolute(this.options.spawn, launch.workspace);
        const goose = await GooseProcess.start(this.options.spawn, {
          cwd,
          env: launch.env,
          tools: this.options.tools,
          serve: this.options.serve,
        });
        const process = { goose, cwd, fingerprint };
        void goose.exited.then(() => {
          if (this.current === current) this.current = undefined;
          for (const [key, live] of this.live)
            if (live.process === process) this.drop(key, live);
        });
        return process;
      })(),
    };
    // A process that failed to start is started again on the next message.
    current.ready.catch(() => {
      if (this.current === current) this.current = undefined;
    });
    this.current = current;
    void old?.ready
      .then((process) => this.retire(process))
      .catch(() => undefined);
    return current.ready;
  }

  /** Stops `process` when it has old settings and nothing runs in it. */
  private retire(process: Process) {
    if (
      !this.disposed &&
      process.fingerprint === this.options.processFingerprint()
    )
      return;
    const users = [...this.live.values(), ...this.once.values()];
    if (users.some((live) => live?.process === process)) return;
    if (this.current?.fingerprint === process.fingerprint)
      this.current = undefined;
    void process.goose.kill();
  }

  private adopt(key: string, live: Live, seen: number) {
    this.had.add(key);
    this.live.set(key, live);
    this.touch(key, live, seen);
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
    void live.process.goose.close(live.session).then(() => {
      this.retire(live.process);
    });
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

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
