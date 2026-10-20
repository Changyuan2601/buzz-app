// Runs a step of claude.ps1 on Windows, the counterpart of `withScript`'s
// `bash -c` elsewhere.
import type { Spawn } from "./claude";
import script from "./claude.ps1?raw";

/** Windows' limit on a whole command line, in UTF-16 units. */
const COMMAND_LINE_LIMIT = 32_767;

/** A PowerShell single-quoted literal. PowerShell also reads the curly
 * single quotes as `'`, so each of them is doubled too. */
const literal = (value: string) =>
  `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;

/** `-EncodedCommand`'s value: `script` called with `args`, as base64 of its
 * UTF-16LE text. The script and its arguments never pass through Windows'
 * command-line quoting, so nothing in them needs escaping there. */
export function encodeCommand(script: string, args: readonly string[]) {
  // Whole-line comments only cost room on the command line.
  const body = script.replace(/^[ \t]*#.*(?:\r?\n|$)/gm, "");
  const command = `& {\n${body}\n} ${args.map(literal).join(" ")}`;
  const bytes = new Uint8Array(command.length * 2);
  for (let i = 0; i < command.length; i++) {
    const unit = command.charCodeAt(i);
    bytes[i * 2] = unit & 0xff;
    bytes[i * 2 + 1] = unit >> 8;
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  // Leaves room for the program and its declared switches.
  if (encoded.length > COMMAND_LINE_LIMIT - 256)
    throw new Error("The Claude setup command is too long for Windows");
  return encoded;
}

/** How long a start that found no `current` waits before looking again. */
const RETRY_MS = 250;
/** The claude.ps1 step behind each process the plugin starts by name. */
const STEPS: Readonly<Record<string, string>> = {
  install: "install",
  platform: "platform",
  use: "use",
};
/** Windows' counterpart of `withScript`: starts `install`, `use` and
 * `platform` as steps of claude.ps1, which the manifest grants as
 * `powershell.exe … -EncodedCommand`. `claude` is Buzz's copy itself, the
 * data program `current\claude.exe`, or `next\claude.exe` when a release is
 * named to test it before it is in use; other processes start as declared. */
export const withPowerShell =
  (spawn: Spawn): Spawn =>
  (id, options) => {
    const step = STEPS[id];
    if (step)
      return spawn("claude-ps", {
        ...options,
        args: [encodeCommand(script, [step, ...(options?.args ?? [])])],
      });
    // A release named to test it is whichever `next` names now; the test
    // checks the version it reports.
    if (id === "claude" && options?.env?.BUZZ_CLAUDE_VERSION)
      return spawn("claude-next", options);
    if (id === "claude")
      return spawn("claude-exe", options).catch(async (error: unknown) => {
        // `use` moves `current` aside a moment before the new link takes its
        // place; a start then finds nothing, so it looks once more.
        if (!/ is not installed$/.test(String(error))) throw error;
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        return spawn("claude-exe", options);
      });
    return spawn(id, options);
  };
