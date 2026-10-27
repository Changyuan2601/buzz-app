import { isTauri } from "@tauri-apps/api/core";

/** The webview of the page that runs agents, apart from the screens. */
export const AGENTS_WEBVIEW = "agents";

/** Whether agents run in their own hidden page, so a screen that is hidden
 * or busy cannot hold them up. The desktop app on macOS opens that page at
 * startup (`agents_window` in src-tauri/src/lib.rs); elsewhere they run in
 * the page that shows them. */
export function agentsRunApart() {
  return (
    isTauri() &&
    typeof navigator !== "undefined" &&
    /^Mac/.test(navigator.platform)
  );
}
