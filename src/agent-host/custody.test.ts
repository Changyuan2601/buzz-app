// @vitest-environment node
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { appExecutable, startCustody } from "./custody";

/** The app's executable in `agent-host` mode, answered by `answer`. */
function fakeApp(
  answer: (request: { id: number; command: string; args?: unknown }) => unknown,
) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  });
  const started: string[][] = [];
  createInterface({ input: child.stdin }).on("line", (line) => {
    const request = JSON.parse(line) as { id: number; command: string };
    child.stdout.write(`${JSON.stringify(answer(request))}\n`);
  });
  child.stdin.on("finish", () => child.emit("exit", 0, null));
  const start = (app: string, args: string[]) => {
    started.push([app, ...args]);
    return child as unknown as ChildProcess;
  };
  return { child, start, started };
}

it("asks the app's executable for one agent's custody, one line per request", async () => {
  const onExit = vi.fn();
  const app = fakeApp(({ id, command, args }) =>
    command === "app_agent_claim"
      ? { id, ok: true }
      : { id, error: `No ${command} ${JSON.stringify(args)}` },
  );
  const custody = startCustody("/app", "a".repeat(64), onExit, app.start);
  expect(app.started).toEqual([["/app", "agent-host", "a".repeat(64)]]);
  await expect(
    custody.call("app_agent_claim", { pubkey: "a".repeat(64) }),
  ).resolves.toBe(true);
  await expect(custody.call("app_agent_create", { x: 1 })).rejects.toThrow(
    'No app_agent_create {"x":1}',
  );
  await custody.close();
  // Closing it is not its stopping on its own.
  expect(onExit).not.toHaveBeenCalled();
  await expect(custody.call("app_agent_claim")).rejects.toThrow("stopped");
});

it("fails what is pending and tells the host when it stops on its own", async () => {
  const onExit = vi.fn();
  const app = fakeApp(() => undefined);
  app.child.stdout.write = () => true;
  const custody = startCustody("/app", "a".repeat(64), onExit, app.start);
  const pending = custody.call("app_agent_claim");
  app.child.emit("exit", null, "SIGKILL");
  await expect(pending).rejects.toThrow(
    "The app's agent custody stopped (SIGKILL)",
  );
  expect(onExit).toHaveBeenCalledWith(
    "The app's agent custody stopped (SIGKILL)",
  );
});

it("runs only Buzz Desktop's executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-host-app-"));
  const bundle = (identifier: string) => {
    const path = join(dir, identifier, "Buzz.app");
    mkdirSync(join(path, "Contents/MacOS"), { recursive: true });
    writeFileSync(
      join(path, "Contents/Info.plist"),
      `<plist><dict><key>CFBundleExecutable</key><string>buzz-foundation</string><key>CFBundleIdentifier</key><string>${identifier}</string></dict></plist>`,
    );
    return path;
  };
  const desktop = bundle("dev.local.buzz.foundation");
  expect(appExecutable({ BUZZ_APP: desktop })).toBe(
    join(desktop, "Contents/MacOS/buzz-foundation"),
  );
  expect(() => appExecutable({ BUZZ_APP: bundle("xyz.block.buzz") })).toThrow(
    "is not Buzz Desktop",
  );
  // An executable, as a dev build's, is taken as it is.
  const executable = join(desktop, "Contents/MacOS/buzz-foundation");
  writeFileSync(executable, "");
  expect(appExecutable({ BUZZ_APP: executable })).toBe(executable);
  expect(() => appExecutable({ BUZZ_APP: join(dir, "missing") })).toThrow(
    "Buzz is not installed",
  );
});
