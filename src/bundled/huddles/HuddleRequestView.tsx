import type { useHuddleRequestFocus } from "./useHuddleRequestFocus";
import { HuddleAvatarMotion } from "./HuddleAvatarMotion";
import type { HuddleAction, HuddleView } from "../../features/huddle/window";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { ArrowsInSimpleIcon } from "../../shared/design-system/icons";
import styles from "./Huddles.module.css";

export function HuddleRequestView({
  view,
  act,
  error,
  focus,
}: {
  focus: ReturnType<typeof useHuddleRequestFocus>;
  view: HuddleView;
  act(action: HuddleAction): void;
  error?: string | undefined;
}) {
  const caller = view.participants[0];
  return (
    <main
      ref={focus.requestRef}
      className={styles.window}
      aria-label="Incoming Huddle request"
    >
      <header className={styles.windowHeader}>
        <div className={styles.windowMinimize}>
          <IconButton
            size="large"
            variant="subtle"
            aria-label="Minimize Huddle request"
            onClick={() => act("minimize")}
            icon={<ArrowsInSimpleIcon size={22} />}
          />
        </div>
      </header>
      <div className={styles.requestBody}>
        {caller && (
          <div className={styles.requestAvatar}>
            <HuddleAvatarMotion participant={caller.key}>
              <Avatar
                size="fill"
                src={caller.picture}
                alt={caller.name}
                fallback={caller.name}
              />
            </HuddleAvatarMotion>
          </div>
        )}
        <p className={`${styles.requestTitle} text-title text-primary`}>
          <span className={styles.requestName}>
            {caller?.name ?? "Someone"}
          </span>{" "}
          is calling
        </p>
      </div>
      <footer className={styles.windowFooter}>
        {error && (
          <p role="alert" className="text-caption text-secondary">
            {error}
          </p>
        )}
        <div className={`${styles.windowControls} ${styles.requestActions}`}>
          <Button
            size="lg"
            variant="subtle"
            data-huddle-join=""
            disabled={view.phase === "connecting"}
            onClick={() => {
              focus.cancel.current?.focus({ preventScroll: true });
              act("join");
            }}
          >
            Join
          </Button>
          <Button
            size="lg"
            variant="destructive"
            ref={focus.cancel}
            onClick={() => act("decline")}
          >
            {view.phase === "connecting" ? "Cancel" : "Decline"}
          </Button>
        </div>
      </footer>
    </main>
  );
}
