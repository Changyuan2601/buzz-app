import { useState, type ReactNode } from "react";
import { readView, writeView } from "../../shared/view-state";
import { ResizeHandle } from "../panels/ResizeHandle";
import styles from "./ResizableSidebar.module.css";

/** Pixel bounds coupled to `.shell-sidebar` in globals.css. */
export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 520;

export function clampSidebarWidth(width: number) {
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

// The width shares the sidebar's saved view record with the channel list's
// scroll and collapse state; each owner merges only its own fields.
const VIEW = "channel-sidebar";
// Preserve explicit resize intent across route remounts when storage is unavailable.
const widths = new Map<string, number>();

/** One width per community/viewer workspace, shared by every primary sidebar. */
export function readSidebarWidth(scope: string): number {
  const memory = widths.get(scope);
  if (memory !== undefined) return memory;
  const saved = readView<{ width?: unknown } | null>(scope, VIEW, null);
  return typeof saved?.width === "number" && Number.isFinite(saved.width)
    ? clampSidebarWidth(saved.width)
    : SIDEBAR_DEFAULT_WIDTH;
}

function saveSidebarWidth(scope: string, width: number) {
  widths.set(scope, width);
  const saved = readView<object | null>(scope, VIEW, null);
  writeView(scope, VIEW, { ...(saved ?? {}), width });
}

/**
 * The primary sidebar column and its resize handle. Pages supply the sidebar
 * contents; width, bounds, persistence and the handle live only here.
 */
export function ResizableSidebar({
  scope,
  className = "shell-sidebar-default",
  children,
}: {
  scope: string;
  className?: string;
  children: ReactNode;
}) {
  // A workspace change reads that workspace's width without remounting the
  // sidebar contents (which would detach focus and in-flight interactions).
  const [view, setView] = useState(() => ({
    scope,
    width: readSidebarWidth(scope),
  }));
  if (view.scope !== scope) setView({ scope, width: readSidebarWidth(scope) });
  const width = view.scope === scope ? view.width : readSidebarWidth(scope);
  const resize = (next: number) => {
    const clamped = clampSidebarWidth(next);
    if (clamped === width) return;
    saveSidebarWidth(scope, clamped);
    setView({ scope, width: clamped });
  };
  return (
    <>
      <div className={className} style={{ width }}>
        {children}
      </div>
      <ResizeHandle
        width={width}
        setWidth={resize}
        min={SIDEBAR_MIN_WIDTH}
        max={SIDEBAR_MAX_WIDTH}
        reset={() => resize(SIDEBAR_DEFAULT_WIDTH)}
        label="Resize sidebar"
        className={styles.handle}
      />
    </>
  );
}
