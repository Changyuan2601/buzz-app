// The app's custody of the agent, served by the installed app's own executable
// (`<app> agent-host <pubkey>`, src-tauri agent_host.rs) without its window.
// The agent's key, its saved identity, its hosting locks and its storage stay
// with the app's code; this host asks for one signed request, read or write
// at a time, with the commands the app's WebView uses (`agentsNative`).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { NativeCall } from "../features/agents/native";

/** The app's identifier: installed and dev builds share it, and its data. */
const APP = "dev.local.buzz.foundation";

/** The app's executable: `BUZZ_APP`, a bundle or an executable, or else the
 * installed app. A bundle must be this app, not another with its name. */
export function appExecutable(env = process.env) {
  const path = env.BUZZ_APP ?? "/Applications/Buzz.app";
  if (!existsSync(path)) throw new Error(`Buzz is not installed at ${path}`);
  if (!statSync(path).isDirectory()) return path;
  const plist = readFileSync(join(path, "Contents/Info.plist"), "utf8");
  const value = (key: string) =>
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(
      plist,
    )?.[1];
  if (value("CFBundleIdentifier") !== APP)
    throw new Error(`${path} is not Buzz Desktop`);
  const executable = value("CFBundleExecutable");
  if (!executable) throw new Error(`${path} has no executable`);
  return join(path, "Contents/MacOS", executable);
}

export type Custody = Readonly<{
  call: NativeCall;
  /** Ends custody; the app's code lets go of the agent's locks as it exits. */
  close(): Promise<void>;
}>;

/** Starts the app's custody of agent `pubkey`. `onExit` hears it stop on its
 * own: the agent is then no longer held, so it must stop running. */
export function startCustody(
  app: string,
  pubkey: string,
  onExit: (reason: string) => void,
  start: (app: string, args: string[]) => ChildProcess = (app, args) =>
    // Its own process group: a Ctrl-C stops the host, which then stops it.
    spawn(app, args, { stdio: ["pipe", "pipe", "inherit"], detached: true }),
): Custody {
  const child = start(app, ["agent-host", pubkey]);
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  let next = 0;
  let ended: string | undefined;
  let closing = false;
  const end = (reason: string) => {
    if (ended) return;
    ended = reason;
    for (const { reject } of pending.values()) reject(new Error(reason));
    pending.clear();
    if (!closing) onExit(reason);
  };
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      end(`The app's agent custody stopped (${signal ?? code})`);
      resolve();
    });
    child.once("error", (error) => {
      end(`The app's agent custody could not run: ${error.message}`);
      resolve();
    });
  });
  if (child.stdout)
    createInterface({ input: child.stdout }).on("line", (line) => {
      let answer: { id?: unknown; ok?: unknown; error?: unknown };
      try {
        answer = JSON.parse(line) as typeof answer;
      } catch {
        return;
      }
      const waiting =
        typeof answer.id === "number" ? pending.get(answer.id) : undefined;
      if (!waiting) return;
      pending.delete(answer.id as number);
      if ("error" in answer) waiting.reject(new Error(String(answer.error)));
      else waiting.resolve(answer.ok);
    });
  const call: NativeCall = (command, args) => {
    if (ended) return Promise.reject(new Error(ended));
    const id = next++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      child.stdin?.write(`${JSON.stringify({ id, command, args })}\n`);
    });
  };
  return Object.freeze({
    call,
    close: async () => {
      closing = true;
      child.stdin?.end();
      await exited;
    },
  });
}
