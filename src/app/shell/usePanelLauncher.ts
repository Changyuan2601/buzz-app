import { useDraftProtection } from "../../features/drafts/DraftProtection";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Panels, RegisteredPanel } from "../../features/panels/service";

type Opened = {
  id: string;
  panel: RegisteredPanel;
  target: string;
  trigger: HTMLButtonElement;
};
export function usePanelLauncher(panels: Panels, ready: boolean) {
  const drafts = useDraftProtection();
  const available = useSyncExternalStore(
    panels.subscribe,
    panels.snapshot,
    panels.snapshot,
  );
  const [opened, setOpened] = useState<Opened>();
  const [focusRequest, setFocusRequest] = useState(0);
  const panelRef = useRef<HTMLElement>(null);
  // Exact installation object, not just key/revision: same-revision re-enable is new intent.
  const selected =
    ready && opened && available.includes(opened.panel) ? opened : undefined;
  useEffect(() => {
    if (opened && !selected) setOpened(undefined);
  }, [opened, selected]);
  const previous = useRef<Opened>(undefined);
  useEffect(() => {
    const before = previous.current;
    previous.current = opened;
    // Focus after the menu's event handling, including first-open fallback bodies.
    // Preserve focus when the panel's content has already claimed it.
    const card = panelRef.current;
    if (
      opened &&
      (before !== opened || focusRequest > 0) &&
      card &&
      !card.contains(document.activeElement)
    )
      card.focus();
    if (
      before &&
      !opened &&
      panels.snapshot().includes(before.panel) &&
      before.trigger.isConnected
    )
      before.trigger.focus();
  }, [opened, panels, focusRequest]);
  return {
    panelRef,
    available: ready ? available : [],
    selected: selected?.panel,
    target: selected?.target,
    openingId: selected?.id,
    opening: selected ? opened : undefined,
    launch(panel: RegisteredPanel, trigger: HTMLButtonElement) {
      if (opened && drafts?.hasRisk(opened)) {
        void drafts.request(opened).then((leave) => {
          if (
            leave &&
            ready &&
            panels.snapshot().includes(panel) &&
            panel.launcher
          )
            setOpened((current) =>
              current !== opened
                ? current
                : current?.panel === panel
                  ? undefined
                  : {
                      id: crypto.randomUUID(),
                      panel,
                      target: panel.launcher?.target ?? "",
                      trigger,
                    },
            );
        });
        return;
      }
      const { launcher } = panel;
      if (ready && launcher && panels.snapshot().includes(panel))
        setOpened((current) =>
          current?.panel === panel
            ? undefined
            : {
                id: crypto.randomUUID(),
                panel,
                target: launcher.target,
                trigger,
              },
        );
    },
    canOpen(target: string) {
      return ready && !!panels.resolve(target);
    },
    /** Show whichever registered panel claims this target; reopening keeps it. */
    open(target: string, trigger: HTMLButtonElement) {
      const same =
        opened?.target === target && opened.panel === panels.resolve(target);
      if (same) {
        setFocusRequest((value) => value + 1);
        return;
      }
      if (opened && drafts?.hasRisk(opened)) {
        void drafts.request(opened).then((leave) => {
          const panel = ready ? panels.resolve(target) : undefined;
          if (leave && panel)
            setOpened((current) =>
              current !== opened
                ? current
                : { id: crypto.randomUUID(), panel, target, trigger },
            );
        });
        return;
      }
      const panel = ready ? panels.resolve(target) : undefined;
      if (panel)
        setOpened((current) => ({
          id:
            current?.panel === panel && current.target === target
              ? current.id
              : crypto.randomUUID(),
          panel,
          target,
          trigger,
        }));
    },
    close() {
      // Bind to this opening, not merely this panel: reopening gets a new lifetime.
      setOpened((current) => (current === opened ? undefined : current));
    },
  };
}
