import type { JsonValue, OpenTarget } from "../../features/navigation/targets";
import { splitPartition } from "../../features/relay/partition";

const agentRoute = /^agent:[0-9a-f]{64}$/;

export function isMeRoute(value: JsonValue): value is string {
  return (
    typeof value === "string" &&
    (value === "new" ||
      (value.startsWith("new:") && value.length > 4 && value.length <= 260) ||
      agentRoute.test(value) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        value,
      ))
  );
}

export function meSelection(target: OpenTarget | undefined) {
  const params = target?.kind === "page" ? target.route?.params : undefined;
  return params !== undefined &&
    isMeRoute(params) &&
    !params.startsWith("new:") &&
    !agentRoute.test(params)
    ? params
    : "new";
}

export function meSection(target: OpenTarget | undefined) {
  const params = target?.kind === "page" ? target.route?.params : undefined;
  return params !== undefined && isMeRoute(params) && params.startsWith("new:")
    ? params.slice(4)
    : undefined;
}

/** The agent a new Solo conversation starts with, when its route names one. */
export function meAgent(target: OpenTarget | undefined) {
  const params = target?.kind === "page" ? target.route?.params : undefined;
  return typeof params === "string" && agentRoute.test(params)
    ? params.slice(6)
    : undefined;
}

/** A new Solo conversation with this agent chosen. Nothing is created until
 * the first message is sent. */
export function meAgentTarget(scope: string, agent: string) {
  return meTarget(scope, `agent:${agent}`);
}

export function meTarget(
  scope: string,
  selected = "new",
  sectionId?: string,
): OpenTarget {
  if (sectionId) selected = `new:${sectionId}`;
  const parts = splitPartition(scope);
  if (!parts || !isMeRoute(selected))
    throw new Error("Invalid Solo destination");
  return {
    version: 1,
    kind: "page",
    pluginId: "buzz.me",
    pageId: "me",
    scope: parts,
    route: { version: 1, params: selected },
  };
}
