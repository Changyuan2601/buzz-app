import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelayData } from "../../features/relay/service";
import type { Reminder, Reminders } from "../../features/relay/reminders";
import type { Navigation } from "../../features/navigation/controller";
import { AlarmIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import {
  TIME_PRESETS,
  endOfToday,
  formatDue,
  groupReminders,
  navigableTarget,
} from "./model";
import { scopeOf, useReminders } from "./react";
import styles from "./Reminders.module.css";

type Clock = { subscribe(listener: () => void): () => void; read(): number };

export function RemindersPage({
  relay,
  navigator,
  clock,
}: {
  relay: RelayData;
  navigator: Navigation;
  clock: Clock;
}) {
  const { connection, reminders, state } = useReminders(relay);
  const now = useSyncExternalStore(clock.subscribe, clock.read, clock.read);
  const [error, setError] = useState<string>();
  // The store whose Retry read is pending; a replaced store's never counts.
  const [retrying, setRetrying] = useState<Reminders>();
  const page = useRef<HTMLDivElement>(null);
  const retryFocus = useRef(false);
  const retryButton = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    // Capture ownership before removal, not after focus has fallen to body.
    return () => {
      retryFocus.current = document.activeElement === button;
    };
  }, []);
  const scope = scopeOf(connection);
  const groups = groupReminders(state.reminders, now, endOfToday());
  const done = groups.find((group) => group.label === "Done");
  const active = groups.filter((group) => group !== done);
  const run = (action: Promise<unknown>) => {
    setError(undefined);
    action.catch(() =>
      setError("The reminder could not be updated. Try again."),
    );
  };
  const open = (reminder: Reminder) => {
    const target = navigableTarget(reminder);
    if (!target || !scope) return;
    void navigator
      .open({
        version: 1,
        kind: "conversation",
        scope,
        channelId: target.channelId,
        messageId: target.eventId,
      })
      .then((result) => {
        if (result.status === "failed")
          setError("This message could not be opened.");
      });
  };
  const status = !reminders
    ? connection.status === "error"
      ? (connection.error ?? "Could not connect.")
      : "Connect to a community to see your reminders."
    : state.status === "loading" && !state.hydrated
      ? "Loading reminders…"
      : undefined;
  const list = (items: readonly Reminder[], reminders: Reminders) => (
    <ul className={styles.list}>
      {items.map((reminder) => (
        <ReminderRow
          key={reminder.id}
          reminder={reminder}
          reminders={reminders}
          open={
            navigableTarget(reminder) && scope
              ? () => open(reminder)
              : undefined
          }
          run={run}
        />
      ))}
    </ul>
  );
  // Any failed read, first or later, keeps Retry up beside whatever list we
  // have until a read succeeds; live arrivals never clear it.
  const failed =
    reminders && state.error !== undefined && state.status !== "loading";
  // Retry stays mounted, busy and focusable, while its own store's read is
  // pending.
  const busy = reminders !== undefined && retrying === reminders;
  const showRetry = failed || busy;
  const retry = (reminders: Reminders) => {
    setRetrying(reminders);
    void reminders
      .refresh()
      .finally(() =>
        setRetrying((current) => (current === reminders ? undefined : current)),
      );
  };
  // When Retry goes away while it had focus, the page takes it, unless the user
  // moved on or another control claimed focus in the same commit.
  useLayoutEffect(() => {
    if (showRetry || !retryFocus.current) return;
    retryFocus.current = false;
    if (document.activeElement === document.body) page.current?.focus();
  }, [showRetry]);
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Reminders">
        <div ref={page} tabIndex={-1} data-buzz-ui="" className={styles.page}>
          <PanelHeader
            title={
              <PanelHeaderLabel
                title="Reminders"
                icon={<AlarmIcon size="1rem" />}
              />
            }
          />
          {error && (
            <p role="alert" className={styles.notice}>
              {error}
            </p>
          )}
          {reminders && showRetry && (
            <div role="alert" className={styles.notice}>
              <p>Some reminders could not be loaded.</p>
              <Button
                ref={retryButton}
                loading={busy}
                onClick={() => retry(reminders)}
              >
                Retry reminders
              </Button>
            </div>
          )}
          {status || !reminders ? (
            <p role="status" className={styles.notice}>
              {status}
            </p>
          ) : failed && !state.hydrated && !state.reminders.length ? null : (
            <>
              {active.length ? (
                active.map((group) => (
                  <section
                    key={group.label}
                    aria-label={group.label}
                    className={styles.group}
                  >
                    <h2 className="text-label text-subtle">{group.label}</h2>
                    {list(group.reminders, reminders)}
                  </section>
                ))
              ) : (
                <section aria-label="Active" className={styles.group}>
                  <h2 className="text-label text-subtle">Active</h2>
                  <p className="text-body text-subtle">No active reminders</p>
                  {!done && (
                    <p className="text-body text-subtle">
                      Use Remind me in a message's menu to get reminded later.
                    </p>
                  )}
                </section>
              )}
              {done && (
                <details className={styles.group}>
                  <summary className="cursor-pointer text-label text-subtle">
                    Done · {done.reminders.length}
                  </summary>
                  {list(done.reminders, reminders)}
                </details>
              )}
            </>
          )}
        </div>
      </FullPageSurface>
    </div>
  );
}

function ReminderRow({
  reminder,
  reminders,
  open,
  run,
}: {
  reminder: Reminder;
  reminders: Reminders;
  open: (() => void) | undefined;
  run(action: Promise<unknown>): void;
}) {
  return (
    <li className={styles.row}>
      <div className={styles.text}>
        <p className="text-body">{reminder.target?.preview || reminder.note}</p>
        {reminder.target && reminder.note && (
          <p className="text-body text-subtle">{reminder.note}</p>
        )}
        {reminder.notBefore !== undefined && (
          <p className="text-label text-subtle">
            {formatDue(reminder.notBefore)}
          </p>
        )}
      </div>
      <div className={styles.actions}>
        {open && <Button onClick={open}>Open</Button>}
        {reminder.status === "pending" && (
          <>
            <MenuRoot>
              <MenuTrigger render={<Button>Snooze</Button>} />
              <MenuPopup>
                {TIME_PRESETS.map((preset) => (
                  <MenuItem
                    key={preset.label}
                    onClick={() =>
                      run(reminders.snooze(reminder.id, preset.at()))
                    }
                  >
                    {preset.label}
                  </MenuItem>
                ))}
              </MenuPopup>
            </MenuRoot>
            <Button onClick={() => run(reminders.complete(reminder.id))}>
              Done
            </Button>
            <Button
              variant="ghost"
              onClick={() => run(reminders.cancel(reminder.id))}
            >
              Cancel
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
