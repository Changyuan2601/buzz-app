import {
  nameIdeasPrompt,
  parseNameIdeas,
} from "../../features/agents/name-ideas";
import type { Spawn } from "./goose";
import type { Config } from "./runtime";
import { briefly } from "./setup";

/** A bare session with the selected provider; no extensions, tools or chat writes. */
export function suggestNames(
  spawn: Spawn | undefined,
  settings: Config,
  exclude: readonly string[],
  signal: AbortSignal,
) {
  const active = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  return briefly(
    spawn,
    async (goose, cwd) => {
      const session = await goose.open({
        cwd,
        systemPrompt: "Return only a JSON array of names.",
        choice: () => ({
          provider: settings.provider.trim(),
          model: settings.model.trim(),
        }),
      });
      try {
        active.throwIfAborted();
        const result = await session.send(nameIdeasPrompt(exclude));
        active.throwIfAborted();
        if (!result.ok)
          throw new Error(result.error ?? "Name suggestions failed.");
        return parseNameIdeas(result.text ?? "", exclude);
      } finally {
        await goose.close(session);
        await goose
          .request("session/delete", { sessionId: session.id })
          .catch(() => undefined);
      }
    },
    { GOOSE_MODE: "chat" },
    active,
  );
}
