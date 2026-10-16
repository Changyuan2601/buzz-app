// An ACP agent's own harness process, started from the launch its owner
// confirmed, on the shared ACP client with no extensions: plain ACP's system
// prompt or a prepend, queued messages instead of steering, and
// `session/close` only when advertised.
import { AcpProcess } from "../../features/agent-harness/acp/process";
import { errorMessage } from "../../features/agent-harness/acp/steps";
import type {
  AcpHooks,
  ServeMcp,
  Spawn,
} from "../../features/agent-harness/acp/types";
import { config, type Launch, launch } from "./config";
import { preset } from "./presets";

/** How long Check waits for the harness to exit once it has answered. */
const CHECK_STOP_MS = 5_000;

export const READY =
  "Ready to start. Sign-in problems show up on the first turn.";

/** The client's hooks for one launch: errors name the preset, and a missing
 * program shows its install hint. */
export function hooks(presetId: string, { command }: Launch): AcpHooks {
  const chosen = preset(presetId);
  return {
    label: chosen?.title ?? command,
    program: "harness",
    missing: `${command} wasn't found or couldn't run. ${
      chosen?.install ?? "Check it's installed and on your PATH."
    }`,
    env: {},
    diagnoseStartup: true,
  };
}

/** Starts the confirmed launch of one read of `stored`, or throws why it
 * can't: the approval is checked against that same read. The process runs
 * `env command ...args`, so the argv reaches the harness exactly. */
export async function start(
  spawn: Spawn,
  stored: unknown,
  options: Readonly<{ serve?: ServeMcp; signal?: AbortSignal }> = {},
) {
  const snapshot = config(stored);
  const found = await launch(snapshot);
  if ("error" in found) throw new Error(found.error);
  const { command, args, env, workspace } = found.launch;
  return AcpProcess.start(spawn, hooks(snapshot.preset, found.launch), {
    cwd: workspace,
    args: [command, ...args],
    env,
    ...options,
  });
}

/** One agent's harness, started when a session first needs it, and again
 * after it exits. `config` is read at each start, so a start always runs
 * what the owner last confirmed. */
export class HarnessProcess {
  private ready: Promise<AcpProcess> | undefined;
  private starting: AbortController | undefined;
  constructor(
    private readonly spawn: Spawn,
    private readonly serve: ServeMcp,
    private readonly config: () => unknown,
  ) {}

  get(): Promise<AcpProcess> {
    if (this.ready) return this.ready;
    const starting = new AbortController();
    const ready = start(this.spawn, this.config(), {
      serve: this.serve,
      signal: starting.signal,
    });
    const forget = () => {
      if (this.ready === ready) this.ready = undefined;
    };
    void ready.then((acp) => acp.exited.then(forget), forget);
    this.ready = ready;
    this.starting = starting;
    return ready;
  }
  /** Stops it, failing every session in it; a start in progress is
   * cancelled and its process killed. */
  stop() {
    const ready = this.ready;
    this.ready = undefined;
    this.starting?.abort(new Error("The harness was stopped"));
    this.starting = undefined;
    void ready?.then((acp) => acp.kill()).catch(() => undefined);
  }
}

/** Starts the confirmed harness once, the way a run does but opening no
 * session, and says whether it can run: why it can't (its program is
 * missing, it refuses Buzz tools, the launch isn't confirmed), or that it's
 * ready. */
export async function check(spawn: Spawn, stored: unknown): Promise<string> {
  try {
    const acp = await start(spawn, stored);
    await acp.stop(CHECK_STOP_MS);
    return READY;
  } catch (error) {
    return errorMessage(error);
  }
}
