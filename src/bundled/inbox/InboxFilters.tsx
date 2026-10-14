import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import styles from "./Inbox.module.css";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import {
  CaretDownIcon,
  BellIcon,
  ArchiveIcon,
  PencilSimpleIcon,
  ChatCircleIcon,
  ChatsCircleIcon,
  AtIcon,
  UserIcon,
  RobotIcon,
  UsersIcon,
  NotificationIcon,
  NotificationFilledIcon,
} from "../../shared/design-system/icons";

export type ShowFilter = "inbox" | "archived";
export type ActivityFilter = "all" | "threads" | "mentions" | "dms";
export type SenderFilter = "everyone" | "humans" | "agents";
const activities = [
  { value: "all", label: "All", icon: <BellIcon size="1rem" /> },
  { value: "mentions", label: "Mentions", icon: <AtIcon size="1rem" /> },
  { value: "threads", label: "Threads", icon: <ChatsCircleIcon size="1rem" /> },
  { value: "dms", label: "DMs", icon: <ChatCircleIcon size="1rem" /> },
] as const;
const views = [
  { value: "inbox", label: "Inbox", icon: <BellIcon size="1rem" /> },
  { value: "archived", label: "Archived", icon: <ArchiveIcon size="1rem" /> },
  { value: "drafts", label: "Drafts", icon: <PencilSimpleIcon size="1rem" /> },
] as const;
const senders = [
  { value: "everyone", label: "Everyone", icon: <UsersIcon size="1rem" /> },
  { value: "humans", label: "People", icon: <UserIcon size="1rem" /> },
  { value: "agents", label: "Agents", icon: <RobotIcon size="1rem" /> },
] as const;

export function InboxViewTabs({
  value,
  triggerRef,
  onChange,
}: {
  value: ShowFilter | "drafts";
  triggerRef: RefObject<HTMLButtonElement | null>;
  onChange(value: ShowFilter | "drafts"): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    triggerRef.current =
      root.current?.querySelector<HTMLButtonElement>(
        `[role="tab"][data-tab-value="${value}"]`,
      ) ?? null;
    return () => {
      triggerRef.current = null;
    };
  }, [value, triggerRef]);
  return (
    <div ref={root} className={styles.viewTabs}>
      <Tabs
        value={value}
        items={views}
        label="Inbox views"
        variant="navigation"
        onValueChange={onChange}
      />
    </div>
  );
}

export function InboxFilters({
  activity,
  sender,
  unreadOnly,
  onActivityChange,
  onSenderChange,
  onUnreadChange,
  onClear,
}: {
  activity: ActivityFilter;
  sender: SenderFilter;
  unreadOnly: boolean;
  onActivityChange(value: ActivityFilter): void;
  onSenderChange(value: SenderFilter): void;
  onUnreadChange(checked: boolean): void;
  onClear(): void;
}) {
  const controls = useRef<HTMLSpanElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const header = controls.current?.closest("header");
    if (!header) return;
    const measure = () =>
      setCompact(
        header.clientWidth <=
          40 *
            Number.parseFloat(
              getComputedStyle(document.documentElement).fontSize,
            ),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  const summaryId = useId();
  const activityLabel = activities.find(
    (item) => item.value === activity,
  )?.label;
  const senderLabel = senders.find((item) => item.value === sender)?.label;
  const filtered = activity !== "all" || sender !== "everyone";
  const summary = `Activity: ${activityLabel}. From: ${senderLabel}.`;
  return (
    <span ref={controls} className={styles.filterControls}>
      <IconButton
        size="sm"
        variant={unreadOnly ? "subtle" : "ghost"}
        aria-label="Unread only"
        aria-pressed={unreadOnly}
        title={unreadOnly ? "Show all read states" : "Show unread only"}
        onClick={() => onUnreadChange(!unreadOnly)}
        icon={
          unreadOnly ? (
            <NotificationFilledIcon size="1rem" />
          ) : (
            <NotificationIcon size="1rem" />
          )
        }
      />
      <MenuRoot>
        <MenuTrigger
          aria-label="Inbox filters"
          aria-describedby={summaryId}
          render={
            compact ? (
              <IconButton
                size="sm"
                aria-label="Inbox filters"
                variant={activity !== "all" ? "subtle" : "ghost"}
                title={`Activity: ${activityLabel}`}
                icon={
                  (
                    activities.find((item) => item.value === activity) ??
                    activities[0]
                  ).icon
                }
              />
            ) : (
              <Button
                size="sm"
                shape="control"
                variant={activity !== "all" ? "subtle" : "ghost"}
                title={`Activity: ${activityLabel}`}
              >
                {activityLabel}
                <CaretDownIcon size="1rem" />
              </Button>
            )
          }
        />
        <span id={summaryId} className="sr-only">
          {summary}
        </span>
        <MenuPopup aria-label="Inbox filters" align="end">
          <MenuRadioGroup value={activity} onValueChange={onActivityChange}>
            {activities.map((item) => (
              <MenuRadioItem key={item.value} value={item.value} closeOnClick>
                <MenuIcon>{item.icon}</MenuIcon>
                {item.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          {(filtered || unreadOnly) && (
            <>
              <MenuSeparator />
              <MenuItem onClick={onClear}>Clear filters</MenuItem>
            </>
          )}
        </MenuPopup>
      </MenuRoot>
      <MenuRoot>
        <MenuTrigger
          aria-label="Filter by sender"
          render={
            compact ? (
              <IconButton
                size="sm"
                aria-label="Filter by sender"
                variant={sender !== "everyone" ? "subtle" : "ghost"}
                title={`From: ${senderLabel}`}
                icon={
                  (senders.find((item) => item.value === sender) ?? senders[0])
                    .icon
                }
              />
            ) : (
              <Button
                size="sm"
                shape="control"
                variant={sender !== "everyone" ? "subtle" : "ghost"}
                title={`From: ${senderLabel}`}
              >
                {senderLabel}
                <CaretDownIcon size="1rem" />
              </Button>
            )
          }
        />
        <MenuPopup aria-label="Filter by sender" align="end">
          <MenuRadioGroup value={sender} onValueChange={onSenderChange}>
            {senders.map((item) => (
              <MenuRadioItem key={item.value} value={item.value} closeOnClick>
                <MenuIcon>{item.icon}</MenuIcon>
                {item.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </MenuRoot>
    </span>
  );
}
