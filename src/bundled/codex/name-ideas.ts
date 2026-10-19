import {
  nameIdeasPrompt,
  parseNameIdeas,
} from "../../features/agents/name-ideas";
import type { Config } from "./config";
import type { Spawn } from "./rpc";

/** Isolated, ephemeral generation: no user/project config, tools, or Buzz access. */
export async function suggestNames(
  spawn: Spawn,
  settings: Config,
  exclude: readonly string[],
  signal: AbortSignal,
) {
  const active = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  active.throwIfAborted();
  let output = "";
  let oversized = false;
  let child: Awaited<ReturnType<Spawn>> | undefined;
  const abort = () => void child?.kill();
  active.addEventListener("abort", abort, { once: true });
  try {
    child = await spawn("codex", {
      cwd: "~",
      args: [
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        ...["shell_tool", "unified_exec", "hooks", "apps", "plugins"].flatMap(
          (flag) => ["--disable", flag],
        ),
        "-c",
        'web_search="disabled"',
        "-c",
        "project_doc_max_bytes=0",
        ...(settings.model ? ["--model", settings.model] : []),
        ...(settings.effort
          ? ["-c", `model_reasoning_effort=${JSON.stringify(settings.effort)}`]
          : []),
        nameIdeasPrompt(exclude),
      ],
      onStdout(data) {
        output += data;
        if (output.length > 128_000) {
          output = output.slice(0, 128_000);
          oversized = true;
          abort();
        }
      },
    });
    if (active.aborted || oversized) await child.kill();
    active.throwIfAborted();
    const code = await child.exited;
    active.throwIfAborted();
    if (oversized)
      throw new Error("Name suggestions exceeded the response limit.");
    if (code !== 0)
      throw new Error(
        "Codex could not suggest names. Check your provider connection.",
      );
    const messages = output.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const text = messages
      .filter(
        (message) =>
          message.type === "item.completed" &&
          message.item?.type === "agent_message" &&
          typeof message.item.text === "string",
      )
      .map((message) => message.item.text)
      .join("\n");
    return parseNameIdeas(text, exclude);
  } finally {
    active.removeEventListener("abort", abort);
    await child?.kill().catch(() => undefined);
  }
}
