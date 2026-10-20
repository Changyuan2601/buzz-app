// Estimated cost of token counts at Anthropic's published first-party API
// rates. Harnesses that record their own cost are not estimated.
import type { TokenCounts } from "../../features/agents/service";

/** USD per million tokens: input, output and cache reads. Cache writes cost
 * 1.25× input for five minutes and 2× for an hour. Claude Haiku 5.5's rate for
 * prompts over 100K tokens is not applied. */
const RATES: Readonly<Record<string, readonly [number, number, number]>> = {
  "claude-fable-5-1": [10, 50, 0.25],
  "claude-mythos-5-1": [10, 50, 0.25],
  "claude-fable-5": [10, 50, 1],
  "claude-mythos-5": [10, 50, 1],
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-opus-5": [5, 25, 0.5],
  "claude-opus-4-8": [5, 25, 0.5],
  "claude-opus-4-7": [5, 25, 0.5],
  "claude-opus-4-6": [5, 25, 0.5],
  "claude-sonnet-5-5": [2, 10, 0.2],
  "claude-sonnet-5": [2, 10, 0.2],
  "claude-sonnet-4-6": [3, 15, 0.3],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
  "claude-haiku-4-5": [1, 5, 0.1],
};

/** The Claude model a provider names, without its prefix or a dated
 * snapshot's date: `databricks-claude-sonnet-5-5`, `claude-haiku-4-5-20251001`. */
export const claudeModel = (model: string) =>
  model.slice(Math.max(0, model.indexOf("claude-"))).replace(/-\d{8}$/, "");

const rates = (model: string) => RATES[claudeModel(model)];

/** The estimated USD of the known counts, `partial` when one it prices is
 * unknown, and without `usd` when none is known; undefined when the model has
 * no known rates. Writes not split by how long they are kept are priced as
 * kept five minutes, Anthropic's default. */
export function estimateCost(
  model: string,
  tokens: TokenCounts,
): { usd?: number; partial: boolean } | undefined {
  const rate = rates(model);
  if (!rate) return undefined;
  const priced = [
    tokens.input,
    tokens.output,
    tokens.cacheRead,
    tokens.cacheWrite,
  ];
  if (priced.every((count) => count === undefined)) return { partial: true };
  const [input, output, read] = rate;
  const hour = tokens.cacheWrite1h ?? 0;
  const minutes = Math.max(0, (tokens.cacheWrite ?? 0) - hour);
  return {
    usd:
      ((tokens.input ?? 0) * input +
        (tokens.output ?? 0) * output +
        (tokens.cacheRead ?? 0) * read +
        minutes * input * 1.25 +
        hour * input * 2) /
      1_000_000,
    partial: priced.some((count) => count === undefined),
  };
}
