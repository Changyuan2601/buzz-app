import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import mapboxgl from "mapbox-gl";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { XIcon } from "../../shared/design-system/icons";
import { RetailerNote } from "./RetailerNote";
import { mapDataEnabled } from "./datasets";
import { retailerResource } from "./retailer-reference";
import type { ComposerResource } from "../../features/conversation/contracts";
import type { Point } from "./model";

export type LocationSelection = {
  id?: string;
  coordinates: Point;
  label?: string;
  name?: string;
  address?: string;
};

function LocationPreview({ coordinates }: { coordinates: Point }) {
  const container = useRef<HTMLDivElement>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!container.current || !import.meta.env.VITE_MAPBOX_TOKEN) return;
    let map: mapboxgl.Map | undefined;
    let marker: mapboxgl.Marker | undefined;
    let resize: ResizeObserver | undefined;
    let theme: MutationObserver | undefined;
    const style = () =>
      `mapbox://styles/mapbox/${document.documentElement.dataset.colorMode === "dark" ? "dark" : "light"}-v11`;
    const dispose = () => {
      resize?.disconnect();
      theme?.disconnect();
      marker?.remove();
      map?.remove();
    };
    try {
      map = new mapboxgl.Map({
        container: container.current,
        accessToken: import.meta.env.VITE_MAPBOX_TOKEN,
        style: style(),
        center: coordinates,
        zoom: 15,
        interactive: false,
        attributionControl: true,
      });
      marker = new mapboxgl.Marker().setLngLat(coordinates).addTo(map);
      resize = new ResizeObserver(() => map?.resize());
      resize.observe(container.current);
      theme = new MutationObserver(() => map?.setStyle(style()));
      theme.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-color-mode"],
      });
    } catch {
      dispose();
      setUnavailable(true);
      return;
    }
    return dispose;
  }, [coordinates]);
  if (unavailable)
    return (
      <p role="status" className="p-4 text-body-sm text-secondary">
        Map preview unavailable. Location details are still available below.
      </p>
    );
  return (
    <div
      ref={container}
      className="buzz-map-detail-preview"
      aria-label="Selected location map"
      role="img"
    />
  );
}

export function LocationDetails({
  selection,
  onClose,
  canAddToMessage = false,
  onAddToMessage,
  onFocusComposer,
  scope,
  channel,
}: {
  selection: LocationSelection;
  scope?: string;
  channel?: string;
  onClose(): void;
  canAddToMessage?: boolean;
  onAddToMessage?: ((resource: ComposerResource) => true | string) | undefined;
  onFocusComposer?: (() => void) | undefined;
}) {
  const added = useRef(false);
  const [savingNote, setSavingNote] = useState(false);
  const [error, setError] = useState<string>();
  const resource = channel ? retailerResource(selection, channel) : undefined;
  return (
    <Dialog.Root
      open
      onOpenChange={(open, details) => {
        if (!open && savingNote) details.cancel();
        else if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          data-buzz-ui=""
          className="buzz-dialog-backdrop buzz-map-detail-backdrop"
        />
        <Dialog.Popup
          data-buzz-ui=""
          className="buzz-map-detail text-body"
          finalFocus={() => {
            if (added.current) {
              onFocusComposer?.();
              return false;
            }
            return undefined;
          }}
        >
          <LocationPreview coordinates={selection.coordinates} />
          <div className="buzz-map-detail-close">
            <Dialog.Close
              disabled={savingNote}
              render={
                <IconButton
                  aria-label="Close location details"
                  icon={<XIcon />}
                  variant="outline"
                  size="sm"
                />
              }
            />
          </div>
          <div className="p-4">
            <Dialog.Title className="text-label">
              {selection.name || selection.label || "Location"}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-body-sm text-secondary">
              {selection.address || "Address unavailable"}
            </Dialog.Description>
            {selection.name && (
              <p className="mt-2 text-body-sm text-secondary">
                {selection.label?.replaceAll("_", " ")}
              </p>
            )}
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                disabled={!canAddToMessage || !resource || savingNote}
                onClick={() => {
                  if (!resource) return;
                  const result = onAddToMessage?.(resource);
                  if (result !== true) {
                    setError(
                      result ||
                        "Couldn’t add this retailer. Check that the message is editable.",
                    );
                    return;
                  }
                  added.current = true;
                  onClose();
                }}
              >
                Add to message
              </Button>
              {error && (
                <p role="alert" className="mt-2 text-body-sm text-secondary">
                  {error}
                </p>
              )}
            </div>
            {mapDataEnabled && selection.id && scope && channel && (
              <RetailerNote
                key={`${scope}:${channel}:${selection.id}`}
                scope={scope}
                channel={channel}
                location={selection.id}
                onSaving={setSavingNote}
              />
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
