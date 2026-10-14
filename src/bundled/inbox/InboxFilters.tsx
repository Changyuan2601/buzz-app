import { useId, type Ref } from "react";
import styles from "./Inbox.module.css";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuGroup,
  MenuGroupLabel,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import {
  CaretDownIcon,
  NotificationIcon,
  NotificationFilledIcon,
} from "../../shared/design-system/icons";

export type ShowFilter = "inbox" | "archived";
export type ActivityFilter = "all" | "threads" | "mentions" | "dms";
export type SenderFilter = "everyone" | "humans" | "agents";
const views = [
  { value: "all", label: "All" },
  { value: "threads", label: "Threads" },
  { value: "mentions", label: "Mentions" },
  { value: "dms", label: "DMs" },
  { value: "drafts", label: "Drafts" },
] as const;

export function InboxFilters({
  view,
  show,
  sender,
  unreadOnly,
  triggerRef,
  onViewChange,
  onShowChange,
  onSenderChange,
  onUnreadChange,
}: {
  view: ActivityFilter | "drafts";
  show: ShowFilter;
  sender: SenderFilter;
  unreadOnly: boolean;
  triggerRef: Ref<HTMLButtonElement>;
  onViewChange(view: ActivityFilter | "drafts"): void;
  onShowChange(show: ShowFilter): void;
  onSenderChange(sender: SenderFilter): void;
  onUnreadChange(checked: boolean): void;
}) {
  const selectionId = useId();
  const drafts = view === "drafts";
  const label = views.find((item) => item.value === view)?.label;
  const summary = drafts
    ? label
    : [
        view === "all" && show === "archived" ? undefined : label,
        show === "archived" ? "Archived" : undefined,
        sender === "everyone"
          ? undefined
          : sender === "humans"
            ? "People"
            : "Agents",
      ]
        .filter(Boolean)
        .join(" · ");
  return (
    <>
      <MenuRoot>
        <MenuTrigger
          ref={triggerRef}
          aria-label="Inbox filters"
          aria-describedby={selectionId}
          render={
            <Button size="sm" variant="ghost" style={{ maxWidth: "100%" }}>
              <span id={selectionId} className={styles.filterSummary}>
                {summary}
              </span>
              <CaretDownIcon size="1rem" />
            </Button>
          }
        />
        <MenuPopup
          aria-label="Inbox filters"
          style={{ maxHeight: "var(--available-height)" }}
        >
          <MenuGroup>
            <MenuGroupLabel emphasis="quiet">Type</MenuGroupLabel>
            <MenuRadioGroup value={view} onValueChange={onViewChange}>
              {views
                .filter((item) => item.value !== "drafts")
                .map((item) => (
                  <MenuRadioItem
                    key={item.value}
                    value={item.value}
                    selection="highlight"
                    closeOnClick
                  >
                    {item.label}
                  </MenuRadioItem>
                ))}
            </MenuRadioGroup>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel emphasis="quiet">From</MenuGroupLabel>
            <MenuCheckboxItem
              checked={sender !== "agents"}
              disabled={drafts || sender === "humans"}
              closeOnClick={false}
              onCheckedChange={(checked) => {
                if (!drafts && (checked || sender === "everyone"))
                  onSenderChange(checked ? "everyone" : "agents");
              }}
            >
              People
            </MenuCheckboxItem>
            <MenuCheckboxItem
              checked={sender !== "humans"}
              disabled={drafts || sender === "agents"}
              closeOnClick={false}
              onCheckedChange={(checked) => {
                if (!drafts && (checked || sender === "everyone"))
                  onSenderChange(checked ? "everyone" : "humans");
              }}
            >
              Agents
            </MenuCheckboxItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel emphasis="quiet">Status</MenuGroupLabel>
            <MenuRadioGroup value={show} onValueChange={onShowChange}>
              <MenuRadioItem
                value="inbox"
                selection="highlight"
                disabled={drafts}
                closeOnClick
              >
                Inbox
              </MenuRadioItem>
              <MenuRadioItem
                value="archived"
                selection="highlight"
                disabled={drafts}
                closeOnClick
              >
                Archived
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
          <MenuSeparator />
          <MenuRadioGroup value={view} onValueChange={onViewChange}>
            <MenuRadioItem value="drafts" selection="highlight" closeOnClick>
              Drafts
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuPopup>
      </MenuRoot>
      {!drafts && (
        <IconButton
          size="sm"
          variant="bare"
          aria-label="Unread only"
          aria-pressed={unreadOnly}
          title="Show unread only"
          onClick={() => onUnreadChange(!unreadOnly)}
          icon={
            unreadOnly ? (
              <NotificationFilledIcon size="1.25rem" />
            ) : (
              <NotificationIcon size="1.25rem" />
            )
          }
        />
      )}
    </>
  );
}
