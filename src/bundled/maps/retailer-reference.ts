import type { ComposerResource } from "../../features/conversation/contracts";
import { parseBuzzLink } from "../../features/navigation/buzz-links";
import { point } from "./model";
import type { LocationSelection } from "./LocationDetails";

/** One explicitly attached business snapshot, not a recipient or an access grant. */
export function readRetailerReference(uri: string):
  | {
      channel: string;
      location: LocationSelection & { name: string; address: string };
    }
  | undefined {
  try {
    const destination = parseBuzzLink(uri);
    if (destination?.format !== "legacy" || destination.messageId) return;
    const url = new URL(uri);
    if (url.searchParams.getAll("retailer").length !== 1) return;
    const value = JSON.parse(url.searchParams.get("retailer") ?? "");
    if (
      value?.version !== 1 ||
      !point(value.coordinates) ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 500 ||
      typeof value.address !== "string" ||
      !value.address.trim() ||
      value.address.length > 2000 ||
      (value.id !== undefined &&
        (typeof value.id !== "string" ||
          !/^square-roster:[0-9a-f]{64}$/.test(value.id))) ||
      (value.label !== undefined &&
        (typeof value.label !== "string" || value.label.length > 200))
    )
      return;
    return {
      channel: destination.channelId,
      location: {
        name: value.name,
        address: value.address,
        coordinates: value.coordinates,
        ...(value.id ? { id: value.id } : {}),
        ...(value.label ? { label: value.label } : {}),
      },
    };
  } catch {
    return;
  }
}

export function retailerResource(
  location: LocationSelection,
  channel: string,
): ComposerResource | undefined {
  const name = location.name?.trim() || location.label?.trim() || "Retailer";
  const uri = new URL(`buzz://channel/${encodeURIComponent(channel)}`);
  uri.searchParams.set(
    "retailer",
    JSON.stringify({
      version: 1,
      name,
      address: location.address?.trim(),
      coordinates: location.coordinates,
      ...(location.id ? { id: location.id } : {}),
      ...(location.label ? { label: location.label } : {}),
    }),
  );
  return readRetailerReference(uri.href)
    ? { uri: uri.href, label: name }
    : undefined;
}
