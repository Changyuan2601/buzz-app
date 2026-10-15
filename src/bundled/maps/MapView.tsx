import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import "./map.css";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ArrowsOutIcon,
  EyeIcon,
  EyeSlashIcon,
  ArrowsClockwiseIcon,
} from "../../shared/design-system/icons";
import { LocationDetails, type LocationSelection } from "./LocationDetails";
import { point, type MapContext, type MapState, type Point } from "./model";
import { loadDataset, mapDataEnabled, type DatasetFeature } from "./datasets";
import type { ComposerResource } from "../../features/conversation/contracts";

function renderedPoint(value: unknown):
  | {
      geometry: { type: "Point"; coordinates: Point };
      properties?: {
        id?: string;
        label?: string;
        name?: string;
        address?: string;
        cluster_id?: number;
      };
    }
  | undefined {
  if (!value || typeof value !== "object" || !("geometry" in value)) return;
  const geometry = value.geometry;
  if (
    !geometry ||
    typeof geometry !== "object" ||
    !("type" in geometry) ||
    geometry.type !== "Point" ||
    !("coordinates" in geometry) ||
    !point(geometry.coordinates)
  )
    return;
  const properties =
    "properties" in value &&
    value.properties &&
    typeof value.properties === "object"
      ? value.properties
      : {};
  return {
    geometry: { type: "Point", coordinates: geometry.coordinates },
    properties: {
      ...("id" in properties &&
      typeof properties.id === "string" &&
      /^square-roster:[0-9a-f]{64}$/.test(properties.id)
        ? { id: properties.id }
        : {}),
      ...("name" in properties && typeof properties.name === "string"
        ? { name: properties.name }
        : {}),
      ...("address" in properties && typeof properties.address === "string"
        ? { address: properties.address }
        : {}),
      ...("label" in properties && typeof properties.label === "string"
        ? { label: properties.label }
        : {}),
      ...("cluster_id" in properties &&
      typeof properties.cluster_id === "number"
        ? { cluster_id: properties.cluster_id }
        : {}),
    },
  };
}
const token = import.meta.env.VITE_MAPBOX_TOKEN;
const style = () =>
  `mapbox://styles/mapbox/${document.documentElement.dataset.colorMode === "dark" ? "dark" : "light"}-v11`;

export function MapView({
  state,
  onContext,
  scope,
  channel,
  onSave,
  canAddToMessage = false,
  onAddToMessage,
  onFocusComposer,
}: {
  state: MapState;
  onContext(context: MapContext): void;
  scope: string;
  channel: string;
  onSave(context: MapContext): void;
  canAddToMessage?: boolean;
  onAddToMessage?(resource: ComposerResource): true | string;
  onFocusComposer?(): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const synchronize = useRef<((next: MapState) => void) | undefined>(undefined);
  const latest = useRef({ state, onContext, onSave });
  latest.current = { state, onContext, onSave };
  const datasetFeatures = useRef<DatasetFeature[]>([]);
  const redraw = useRef<(() => void) | undefined>(undefined);
  const [selection, setSelection] = useState<LocationSelection>();
  const [locationsVisible, setLocationsVisible] = useState(true);
  const visibility = useRef(true);
  const controls = useRef<
    { fit(): void; clear(): void; visibility(): void } | undefined
  >(undefined);
  const [reload, setReload] = useState(0);
  const [dataStatus, setDataStatus] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: The refresh counter intentionally starts a new query.
  useEffect(() => {
    controls.current?.clear();
    const abort = new AbortController();
    datasetFeatures.current = [];
    redraw.current?.();
    if (!state.datasets?.length) {
      setDataStatus(undefined);
      return;
    }
    if (!mapDataEnabled) {
      setDataStatus("The local dataset service is unavailable in this build.");
      return;
    }
    setDataStatus("Loading Square locations from Snowflake…");
    void Promise.all(
      state.datasets.map((id) => loadDataset(id, scope, channel, abort.signal)),
    )
      .then((results) => {
        if (abort.signal.aborted) return;
        datasetFeatures.current = results.flat();
        redraw.current?.();
        setDataStatus(
          `${datasetFeatures.current.length.toLocaleString()} locations loaded`,
        );
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          abort.abort();
          setDataStatus(
            "Dataset could not load. Check Snowflake access; no partial results were plotted.",
          );
        }
      });
    return () => abort.abort();
  }, [state.datasets, scope, channel, reload]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!container.current || !token) return;
    const element = container.current;
    let instance: mapboxgl.Map;
    const popup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      className: "buzz-map-preview",
      offset: 12,
    });
    let selected: MapContext["selected"];
    try {
      instance = new mapboxgl.Map({
        container: container.current,
        accessToken: token,
        style: style(),
        center: latest.current.state.center,
        zoom: latest.current.state.zoom,
        attributionControl: false,
      });
    } catch {
      setError("Map could not start. Check WebGL support.");
      return;
    }

    instance.addControl(new mapboxgl.NavigationControl(), "bottom-right");
    instance.addControl(
      new mapboxgl.ScaleControl({ maxWidth: 100 }),
      "bottom-left",
    );
    instance.addControl(new mapboxgl.AttributionControl({ compact: true }));
    const report = () => {
      const center = instance.getCenter(),
        bounds = instance.getBounds();
      latest.current.onContext({
        ...latest.current.state,
        center: [((((center.lng + 180) % 360) + 360) % 360) - 180, center.lat],
        zoom: instance.getZoom(),
        ...(bounds
          ? {
              bounds: [
                bounds.getSouthWest().toArray(),
                bounds.getNorthEast().toArray(),
              ] as [Point, Point],
            }
          : {}),
        ...(selected ? { selected } : {}),
      });
    };
    const draw = () => {
      const points: mapboxgl.GeoJSONSourceSpecification["data"] = {
        type: "FeatureCollection",
        features: [
          ...datasetFeatures.current,
          ...latest.current.state.markers.map((marker) => ({
            type: "Feature" as const,
            properties: { label: marker.label },
            geometry: {
              type: "Point" as const,
              coordinates: marker.coordinates,
            },
          })),
        ],
      };
      const pointsSource = instance.getSource("maps-points") as
        | mapboxgl.GeoJSONSource
        | undefined;
      if (pointsSource) pointsSource.setData(points);
      else {
        instance.addSource("maps-points", {
          type: "geojson",
          data: points,
          cluster: true,
          clusterRadius: 42,
          clusterMaxZoom: 9,
        });
        instance.addLayer({
          id: "maps-clusters",
          type: "circle",
          source: "maps-points",
          filter: ["has", "point_count"],
          paint: {
            "circle-color": getComputedStyle(element)
              .getPropertyValue("--text-secondary")
              .trim(),
            "circle-radius": [
              "step",
              ["get", "point_count"],
              12,
              25,
              16,
              100,
              20,
              250,
              24,
              500,
              28,
            ],
            "circle-stroke-color": getComputedStyle(
              element.parentElement ?? element,
            ).backgroundColor,
            "circle-stroke-width": 1.25,
          },
        });
        instance.addLayer({
          id: "maps-cluster-count",
          type: "symbol",
          source: "maps-points",
          filter: ["has", "point_count"],
          layout: {
            "text-field": ["get", "point_count_abbreviated"],
            "text-size": 11,
          },
          paint: {
            "text-color": getComputedStyle(element).color,
          },
        });
        instance.addLayer({
          id: "maps-locations",
          type: "circle",
          source: "maps-points",
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-color": getComputedStyle(element)
              .getPropertyValue("--text-secondary")
              .trim(),
            "circle-radius": [
              "interpolate",
              ["linear"],
              ["zoom"],
              8,
              2.6,
              11,
              3.35,
              14,
              4.2,
            ],
            "circle-opacity": 0.74,
            "circle-stroke-width": 0.9,
            "circle-stroke-color": getComputedStyle(
              element.parentElement ?? element,
            ).backgroundColor,
          },
        });
      }
      const data: mapboxgl.GeoJSONSourceSpecification["data"] = {
        type: "FeatureCollection",
        features: latest.current.state.lines.map((line) => ({
          type: "Feature" as const,
          properties: { label: line.label },
          geometry: {
            type: "LineString" as const,
            coordinates: line.coordinates,
          },
        })),
      };
      const source = instance.getSource("maps-lines") as
        | mapboxgl.GeoJSONSource
        | undefined;
      if (source) source.setData(data);
      else {
        instance.addSource("maps-lines", { type: "geojson", data });
        instance.addLayer({
          id: "maps-lines",
          type: "line",
          source: "maps-lines",
          paint: {
            "line-color": getComputedStyle(element).color,
            "line-width": 4,
          },
        });
      }
      for (const id of [
        "maps-clusters",
        "maps-cluster-count",
        "maps-locations",
      ])
        if (instance.getLayer(id))
          instance.setLayoutProperty(
            id,
            "visibility",
            visibility.current ? "visible" : "none",
          );
      report();
    };
    controls.current = {
      visibility: () => {
        if (instance.isStyleLoaded()) draw();
      },
      clear: () => {
        selected = undefined;
        setSelection(undefined);
        popup.remove();
        report();
      },
      fit: () => {
        const coordinates = [
          ...datasetFeatures.current.map(
            (feature) => feature.geometry.coordinates,
          ),
          ...latest.current.state.markers.map((marker) => marker.coordinates),
        ];
        if (!coordinates.length) return;
        const bounds = new mapboxgl.LngLatBounds(
          coordinates[0],
          coordinates[0],
        );
        for (const coordinatesOfPoint of coordinates)
          bounds.extend(coordinatesOfPoint);
        instance.fitBounds(bounds, { padding: 64, maxZoom: 16 });
      },
    };
    redraw.current = () => {
      if (instance.isStyleLoaded()) draw();
    };
    instance.on("style.load", draw);
    instance.on("moveend", () => {
      report();
      latest.current.onSave({
        ...latest.current.state,
        center: [
          ((((instance.getCenter().lng + 180) % 360) + 360) % 360) - 180,
          instance.getCenter().lat,
        ],
        zoom: instance.getZoom(),
      });
    });
    instance.on("mousemove", "maps-locations", (event) => {
      const feature = renderedPoint(event.features?.[0]);
      if (!feature) return;
      instance.getCanvas().style.cursor = "pointer";
      const content = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent =
        feature.properties?.name || feature.properties?.label || "Location";
      content.append(title);
      for (const text of [
        feature.properties?.address,
        feature.properties?.name
          ? feature.properties?.label?.replaceAll("_", " ")
          : undefined,
      ]) {
        if (!text) continue;
        const line = document.createElement("p");
        line.textContent = text;
        content.append(line);
      }
      popup
        .setLngLat(feature.geometry.coordinates)
        .setDOMContent(content)
        .addTo(instance);
    });
    instance.on("mouseleave", "maps-locations", () => {
      instance.getCanvas().style.cursor = "";
      popup.remove();
    });
    instance.on("move", report);
    instance.on("click", (event) => {
      const feature = renderedPoint(
        instance.queryRenderedFeatures(event.point, {
          layers: ["maps-locations", "maps-clusters"].filter((id) =>
            instance.getLayer(id),
          ),
        })[0],
      );
      if (
        feature?.properties?.cluster_id !== undefined &&
        feature.geometry.type === "Point"
      ) {
        const source = instance.getSource(
          "maps-points",
        ) as mapboxgl.GeoJSONSource;
        source.getClusterExpansionZoom(
          Number(feature.properties.cluster_id),
          (error, zoom) => {
            if (!error && zoom != null)
              instance.easeTo({ center: feature.geometry.coordinates, zoom });
          },
        );
        return;
      }
      setSelection(undefined);
      selected = {
        coordinates: [event.lngLat.lng, event.lngLat.lat],
        label: "Selected location",
      };
      if (feature?.geometry.type === "Point") {
        selected = {
          coordinates: feature.geometry.coordinates as Point,
          label: String(feature.properties?.label ?? "Location"),
        };
        setSelection({
          ...feature.properties,
          coordinates: feature.geometry.coordinates,
        });
        popup.remove();
      }
      report();
    });
    instance.on("error", () =>
      setError(
        "Map data could not load. Check your connection and Mapbox configuration.",
      ),
    );
    instance.on("idle", () => setError(undefined));
    // Mapbox's container changes when the chat pane or window is resized.
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(container.current);
    const theme = new MutationObserver(() => instance.setStyle(style()));
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-color-mode"],
    });
    // Plugin-owned map data updates use the existing instance; viewport motion is not a remount.
    const update = (next: MapState) => {
      latest.current.state = next;
      selected = undefined;
      setSelection(undefined);
      popup.remove();
      instance.flyTo({
        center: latest.current.state.center,
        zoom: latest.current.state.zoom,
        essential: false,
      });
      if (instance.isStyleLoaded()) draw();
    };
    synchronize.current = update;
    return () => {
      controls.current = undefined;
      synchronize.current = undefined;
      resize.disconnect();
      theme.disconnect();
      redraw.current = undefined;
      popup.remove();
      instance.remove();
    };
  }, []);
  useEffect(() => {
    synchronize.current?.(state);
  }, [state]);
  useEffect(() => {
    visibility.current = locationsVisible;
    controls.current?.visibility();
  }, [locationsVisible]);
  return (
    <div className="buzz-map relative h-full min-h-0 flex-1 bg-surface text-primary">
      <section
        ref={container}
        className="h-full w-full"
        aria-label="Interactive map"
      />
      <fieldset className="buzz-map-toolbar" aria-label="Map controls">
        <IconButton
          aria-label="Fit locations"
          title="Fit locations"
          icon={<ArrowsOutIcon />}
          variant="outline"
          size="sm"
          onClick={() => controls.current?.fit()}
        />
        <IconButton
          aria-label={locationsVisible ? "Hide locations" : "Show locations"}
          title={locationsVisible ? "Hide locations" : "Show locations"}
          icon={locationsVisible ? <EyeIcon /> : <EyeSlashIcon />}
          variant="outline"
          size="sm"
          aria-pressed={locationsVisible}
          onClick={() => setLocationsVisible((value) => !value)}
        />
        {state.datasets?.length ? (
          <IconButton
            aria-label="Refresh data"
            title="Refresh data"
            icon={<ArrowsClockwiseIcon />}
            variant="outline"
            size="sm"
            onClick={() => setReload((value) => value + 1)}
          />
        ) : null}
      </fieldset>
      {selection && locationsVisible && (
        <LocationDetails
          key={JSON.stringify([
            scope,
            channel,
            selection.id ?? selection.coordinates,
          ])}
          scope={scope}
          channel={channel}
          selection={selection}
          onClose={() => controls.current?.clear()}
          canAddToMessage={canAddToMessage}
          onAddToMessage={onAddToMessage}
          onFocusComposer={onFocusComposer}
        />
      )}
      {dataStatus && (
        <p
          role="status"
          className="absolute left-4 top-16 max-w-[calc(100%-2rem)] rounded-lg bg-surface p-2 text-body-sm text-secondary"
        >
          {dataStatus}
        </p>
      )}
      {(!token || error) && (
        <p
          role="alert"
          className="absolute left-4 top-4 rounded-lg bg-surface p-3 text-body-sm text-primary"
        >
          {token ? error : "Set VITE_MAPBOX_TOKEN to load the map."}
        </p>
      )}
    </div>
  );
}
