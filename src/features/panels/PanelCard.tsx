import { usePanelTabHost } from "./PanelWorkspace";
import { useMemo, useRef, useEffect, type Ref } from "react";
import { DraftScope, useDraftScope } from "../drafts/react";
import { useDraftProtection } from "../drafts/DraftProtection";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { XIcon } from "../../shared/design-system/icons/index";
import type { PanelProps, RegisteredPanel } from "./service";
import { PanelSubviewHost } from "./PanelSubview";
import { PanelView } from "./PanelView";
import styles from "./Panels.module.css";

// Ordinary shared UI: the caller still owns placement and selection.
export function PanelCard({
  ref,
  panel,
  ...props
}: PanelProps & {
  ref?: Ref<HTMLElement>;
  panel: RegisteredPanel;
}) {
  const tabbed = !!usePanelTabHost();
  const guard = useDraftProtection();
  const parentScope = useDraftScope();
  const ownScope = useMemo(
    () => ({ panel, target: props.target }),
    [panel, props.target],
  );
  const scope = parentScope ?? ownScope;
  const live = useRef<object | undefined>(scope);
  useEffect(() => {
    live.current = scope;
    return () => {
      live.current = undefined;
    };
  }, [scope]);
  const requestClose = () => {
    if (guard?.hasRisk(scope))
      void guard.request(scope).then((leave) => {
        if (leave && live.current === scope) props.close();
      });
    else props.close();
  };
  return (
    <DraftScope scope={scope}>
      <aside
        ref={ref}
        tabIndex={-1}
        className={styles.cardLayout}
        aria-label={panel.title}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            !tabbed &&
            !event.defaultPrevented &&
            !event.nativeEvent.isComposing
          ) {
            event.stopPropagation();
            requestClose();
          }
        }}
      >
        <Panel as="div">
          <PanelSubviewHost close={requestClose}>
            <div className={styles.card}>
              {!tabbed && (
                <PanelHeader
                  title={
                    panel.launcher ? (
                      <PanelHeaderLabel
                        title={panel.title}
                        icon={<img src={panel.launcher.icon} alt="" />}
                      />
                    ) : (
                      panel.title
                    )
                  }
                  actions={
                    <IconButton
                      size="toolbar"
                      aria-label={`Close ${panel.title} panel`}
                      onClick={requestClose}
                      icon={<XIcon size={18} aria-hidden="true" />}
                    />
                  }
                />
              )}
              <div className={styles.content}>
                <PanelView panel={panel} {...props} />
              </div>
            </div>
          </PanelSubviewHost>
        </Panel>
      </aside>
    </DraftScope>
  );
}
