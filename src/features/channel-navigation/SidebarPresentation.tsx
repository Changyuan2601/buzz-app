import {
  createContext,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import styles from "./SidebarPresentation.module.css";

export const SidebarPresentation = createContext({ compact: false, visit: "" });
export const useSidebarPresentation = () => useContext(SidebarPresentation);
const FlyoutSelection = createContext({
  active: undefined as string | undefined,
  select: (_id: string, _open: boolean) => {},
});

export function SidebarPresentationProvider({
  value,
  children,
}: {
  value: { compact: boolean; visit: string };
  children: ReactNode;
}) {
  const key = `${value.compact}:${value.visit}`;
  const [selection, setSelection] = useState<{
    key: string;
    active?: string | undefined;
  }>({ key });
  if (selection.key !== key) setSelection({ key });
  const flyout = useMemo(
    () => ({
      active: selection.key === key ? selection.active : undefined,
      select: (id: string, open: boolean) =>
        setSelection((current) =>
          open
            ? { key, active: id }
            : current.active === id
              ? { key }
              : current,
        ),
    }),
    [key, selection],
  );
  return (
    <SidebarPresentation value={value}>
      <FlyoutSelection value={flyout}>{children}</FlyoutSelection>
    </SidebarPresentation>
  );
}

/** The inventory retains its actions and rows; only their presentation changes. */
export function SidebarFlyout({
  title,
  icon,
  count,
  children,
}: {
  title: string;
  icon: ReactNode;
  count?: number | undefined;
  children: ReactNode;
}) {
  const countId = useId();
  const container = useRef<HTMLDivElement>(null);
  const presentation = useSidebarPresentation();
  const flyout = useContext(FlyoutSelection);
  if (!presentation.compact) return children;
  return (
    <PopoverRoot
      open={flyout.active === countId}
      onOpenChange={(open) => flyout.select(countId, open)}
    >
      <div ref={container} className={styles.entry}>
        <PopoverTrigger
          openOnHover
          render={
            <IconButton
              aria-label={title}
              title={title}
              aria-describedby={count === undefined ? undefined : countId}
              icon={<span aria-hidden="true">{icon}</span>}
            />
          }
        />
        {count !== undefined && (
          <>
            <span className={styles.count} aria-hidden="true">
              {count}
            </span>
            <span id={countId} className="sr-only">
              {count} items
            </span>
          </>
        )}
        <PopoverPopup
          container={container}
          positionMethod="fixed"
          side="right"
          align="start"
          padding="list"
          aria-label={title}
        >
          <SidebarPresentation value={{ ...presentation, compact: false }}>
            {children}
          </SidebarPresentation>
        </PopoverPopup>
      </div>
    </PopoverRoot>
  );
}
