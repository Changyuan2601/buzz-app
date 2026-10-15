import { point, parseMap, type MapState } from "./model";

export const mapDataEnabled = import.meta.env.VITE_BUZZ_MAP_DATA === "1";
export type DatasetFeature = {
  type: "Feature";
  properties: { label: string; name?: string; address?: string; id?: string };
  geometry: { type: "Point"; coordinates: [number, number] };
};
function endpoint(path: string, scope: string, channel: string) {
  return `/api/maps/${path}?${new URLSearchParams({ scope, channel })}`;
}
export async function loadDataset(
  id: string,
  scope: string,
  channel: string,
  signal: AbortSignal,
) {
  const response = await fetch(endpoint(`datasets/${id}`, scope, channel), {
    signal,
    cache: "no-store",
  });
  if (!response.ok || !response.body)
    throw new Error("Dataset unavailable in this channel.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const features: DatasetFeature[] = [];
  let buffer = "",
    complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const row = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (complete || row.error)
          throw new Error("Query failed; the complete dataset was not loaded.");
        if (row.complete === true) {
          if (row.count !== features.length)
            throw new Error("Dataset count mismatch.");
          complete = true;
        } else {
          const feature = row.feature;
          if (
            feature?.type !== "Feature" ||
            feature.geometry?.type !== "Point" ||
            !point(feature.geometry.coordinates) ||
            typeof feature.properties?.label !== "string"
          )
            throw new Error("Invalid dataset geometry.");
          features.push({
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: feature.geometry.coordinates,
            },
            properties: {
              label: feature.properties.label,
              ...(/^square-roster:[0-9a-f]{64}$/.test(
                feature.properties.id ?? "",
              )
                ? { id: feature.properties.id as string }
                : {}),
              ...(typeof feature.properties.name === "string"
                ? { name: feature.properties.name }
                : {}),
              ...(typeof feature.properties.address === "string"
                ? { address: feature.properties.address }
                : {}),
            },
          });
        }
      }
    }
    if (!complete || buffer.length)
      throw new Error("Dataset stream was interrupted.");
    return features;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export async function loadView(
  scope: string,
  channel: string,
  signal: AbortSignal,
) {
  const response = await fetch(endpoint("view", scope, channel), {
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Saved map could not load.");
  const { view } = await response.json();
  if (view === null) return null;
  const parsed = parseMap(view);
  if (!parsed) throw new Error("Invalid saved map.");
  return parsed;
}
export async function saveView(scope: string, channel: string, map: MapState) {
  const response = await fetch(endpoint("view", scope, channel), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      center: map.center,
      zoom: map.zoom,
      datasets: map.datasets ?? [],
      markers: [],
      lines: [],
    }),
  });
  if (!response.ok) throw new Error("Map view could not be saved.");
}
