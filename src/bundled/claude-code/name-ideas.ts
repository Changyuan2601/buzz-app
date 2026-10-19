import {
  nameIdeasPrompt,
  parseNameIdeas,
} from "../../features/agents/name-ideas";
import type { HostProcess } from "../../features/host/service";
import { ClaudeProcess, type Spawn } from "./claude";
import type { Config } from "./runtime";

/** A tools-free request using the connected provider, separate from chat sessions. */
export async function suggestNames(
  spawn: Spawn,
  settings: Config,
  exclude: readonly string[],
  signal: AbortSignal,
): Promise<readonly string[]> {
  const active = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let process: ClaudeProcess | undefined;
  let child: HostProcess | undefined;
  let output = "";
  let oversized = false;
  const abort = () => void child?.kill();
  active.addEventListener("abort", abort, { once: true });
  try {
    active.throwIfAborted();
    process = await ClaudeProcess.start(
      async (id, options) => {
        active.throwIfAborted();
        child = await spawn(id, {
          ...options,
          onStdout(data) {
            options?.onStdout?.(data);
            output += data;
            if (output.length > 128_000) {
              oversized = true;
              output = output.slice(0, 128_000);
              void child?.kill();
            }
          },
        });
        if (active.aborted || oversized) await child.kill();
        active.throwIfAborted();
        return child;
      },
      {
        cwd: "~",
        discovery: true,
        systemPrompt:
          "Return only a JSON array of name suggestions. No tools or external actions.",
        ...(settings.model.trim() ? { model: settings.model.trim() } : {}),
        ...(settings.effort ? { effort: settings.effort } : {}),
      },
    );
    active.throwIfAborted();
    const result = await process.send(nameIdeasPrompt(exclude));
    active.throwIfAborted();
    if (!result.ok) throw new Error(result.error ?? "Name suggestions failed.");
    if (oversized)
      throw new Error("Name suggestions exceeded the response limit.");
    const messages = output.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const text = messages
      .filter((message) => message.type === "assistant")
      .flatMap((message) => message.message?.content ?? [])
      .filter(
        (block) => block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("\n")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    return parseNameIdeas(text, exclude);
  } finally {
    active.removeEventListener("abort", abort);
    await child?.kill().catch(() => undefined);
  }
}
