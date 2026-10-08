import { isTauri } from "@tauri-apps/api/core";
import {
  hasIntegratedWindowControls,
  WindowControls,
} from "../../app/shell/WindowControls";
import { macTitleBarDragHandlers } from "../../app/shell/title-bar";

/** Screens shown before the app shell keep the undecorated window draggable. */
export function SetupWindowHeader() {
  const macDesktop = isTauri() && /Mac/i.test(navigator.platform);
  const integratedWindowControls = hasIntegratedWindowControls();
  if (!macDesktop && !integratedWindowControls) return null;
  return (
    <header
      className="-mx-8 -mt-8 mb-8 flex h-14 items-center justify-end px-3"
      data-tauri-drag-region={integratedWindowControls || undefined}
      {...(macDesktop ? macTitleBarDragHandlers : {})}
    >
      <WindowControls />
    </header>
  );
}
