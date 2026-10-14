export type Config = {
  model: string;
  effort: string;
  /** Legacy instructions, present only until migration strips them. */
  instructions?: string;
  workspace: string;
  scope: "thread" | "channel";
};
export type Model = {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
};
export const defaults: Config = {
  model: "",
  effort: "",
  workspace: "~/.buzz",
  scope: "thread",
};
export function config(raw: unknown): Config {
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    model: typeof value.model === "string" ? value.model : "",
    effort: typeof value.effort === "string" ? value.effort : "",
    ...(typeof value.instructions === "string" && {
      instructions: value.instructions,
    }),
    workspace:
      typeof value.workspace === "string" && value.workspace.trim()
        ? value.workspace.trim()
        : defaults.workspace,
    scope: value.scope === "channel" ? "channel" : "thread",
  };
}
export const effortName = (effort: string) =>
  ({ xhigh: "Extra high", max: "Maximum", ultra: "Ultra" })[effort] ??
  `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;

export const absoluteWorkspace = (path: string) =>
  path.trim().startsWith("/") || /^[A-Za-z]:[\\/]/.test(path.trim());

/** An absolute path, or one under the home directory written `~/…`, which the
 * process host expands. */
export const validWorkspace = (path: string) =>
  /^~(\/|$)/.test(path.trim()) || absoluteWorkspace(path);
