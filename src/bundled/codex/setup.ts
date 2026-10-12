// Codex's installer and sign-in, each run as a declared process. One owner for
// the whole plugin, so leaving a tab mid-install cannot start a second one.
import type { HostProcess } from "../../features/host/service";
import type { Spawn } from "./rpc";

export type Step = "install" | "login";
export type SetupState = Readonly<{
  running: Step | undefined;
  /** The running or last step's output. */
  output: string;
  /** Counts finished steps, so views check Codex again after each. */
  finished: number;
}>;
const OUTPUT_LIMIT = 20_000;
// The installer otherwise asks to start Codex on a terminal the app inherited.
const ENV = { CODEX_NON_INTERACTIVE: "1" };

export class CodexSetup {
  private state: SetupState = { running: undefined, output: "", finished: 0 };
  private readonly listeners = new Set<() => void>();
  private process: HostProcess | undefined;
  /** Cancel was asked for before the running step's process was returned. */
  private cancelled = false;

  constructor(
    private readonly spawn: Spawn,
    /** Runs after each step, whether or not a view is open. */
    private readonly onFinish = () => {},
  ) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(change: Partial<SetupState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  async run(step: Step) {
    if (this.state.running) return;
    this.cancelled = false;
    this.set({ running: step, output: "" });
    const append = (text: string) =>
      this.set({ output: (this.state.output + text).slice(-OUTPUT_LIMIT) });
    try {
      this.process = await this.spawn(step, {
        env: ENV,
        onStdout: append,
        onStderr: append,
      });
      if (this.cancelled) void this.process.kill();
      const code = await this.process.exited;
      if (code !== 0)
        append(
          `\n${step === "install" ? "Install" : "Sign-in"} ended (${code ?? "stopped"}).`,
        );
    } catch (error) {
      append(`\n${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.process = undefined;
      this.set({ running: undefined, finished: this.state.finished + 1 });
      this.onFinish();
    }
  }
  cancel() {
    this.cancelled = true;
    return this.process?.kill();
  }
}
