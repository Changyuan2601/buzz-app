import { createContext, useContext, useLayoutEffect } from "react";
import type { ComposerToolProps } from "../../features/conversation/contracts";

export type MapComposer = Pick<
  ComposerToolProps,
  "insertResource" | "focus" | "disabled"
>;
// The existing tool host revokes these commands when its composer is disabled,
// retargeted or unmounted. Each Maps workspace binds only its visible composer.
export const MapComposerBinding = createContext<
  ((composer: MapComposer | undefined) => void) | undefined
>(undefined);
export function MapComposerTool({
  insertResource,
  focus,
  disabled,
}: ComposerToolProps) {
  const bind = useContext(MapComposerBinding);
  useLayoutEffect(() => {
    if (!bind) return;
    bind({ insertResource, focus, disabled });
    return () => bind(undefined);
  }, [bind, insertResource, focus, disabled]);
  return null;
}
