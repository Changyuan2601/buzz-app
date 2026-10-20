// Runs a step of claude.ps1 on Windows, the counterpart of `withScript`'s
// `bash -c` elsewhere.
import type { Spawn } from "./claude";

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

/** Starts `install` and `use` as steps of claude.ps1, which the manifest
 * grants as `powershell.exe … -EncodedCommand`; other processes start as
 * declared. */
export const withPowerShell =
  (
    spawn: Spawn,
    script: string,
    steps: Readonly<Record<string, string>>,
  ): Spawn =>
  (id, options) => {
    const step = steps[id];
    return step
      ? spawn("claude-ps", {
          ...options,
          args: [encodeCommand(script, [step, ...(options?.args ?? [])])],
        })
      : spawn(id, options);
  };
