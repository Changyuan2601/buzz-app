import type { JsonValue, OpenTarget } from "../../features/navigation/targets";
import { splitPartition } from "../../features/relay/partition";

export function isMeRoute(value: JsonValue): value is string {
  return (
    typeof value === "string" &&
    (value === "new" ||
      (value.startsWith("new:") && value.length > 4 && value.length <= 260) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        value,
      ))
  );
}

export function meSelection(target: OpenTarget | undefined) {
  const params = target?.kind === "page" ? target.route?.params : undefined;
  return params !== undefined && isMeRoute(params) && !params.startsWith("new:")
    ? params
    : "new";
}

export function meSection(target: OpenTarget | undefined) {
  const params = target?.kind === "page" ? target.route?.params : undefined;
  return params !== undefined && isMeRoute(params) && params.startsWith("new:")
    ? params.slice(4)
    : undefined;
}

export function meTarget(
  scope: string,
  selected = "new",
  sectionId?: string,
): OpenTarget {
  if (sectionId) selected = `new:${sectionId}`;
  const parts = splitPartition(scope);
  if (!parts || !isMeRoute(selected)) throw new Error("Invalid Me destination");
  return {
    version: 1,
    kind: "page",
    pluginId: "buzz.me",
    pageId: "me",
    scope: parts,
    route: { version: 1, params: selected },
  };
}
