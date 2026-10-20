import { isBuzzLink } from "../../features/navigation/buzz-links";
import { useHuddleRequestFocus } from "./useHuddleRequestFocus";
import { HuddleAudioSettings } from "./HuddleAudioSettings";
import { LayoutGroup } from "motion/react";
import { useId } from "react";
import { HuddleRequestView } from "./HuddleRequestView";
import type { HuddleAction, HuddleView } from "../../features/huddle/window";
import { useLayoutEffect, useRef, useState } from "react";
import { useHuddleComposer } from "./HuddleComposer";
import { HuddleAvatarCloud } from "./HuddleAvatarCloud";
import { HuddleDiscussionView } from "./HuddleDiscussionView";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ChatCircleIcon,
  ArrowsInSimpleIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneDisconnectIcon,
} from "../../shared/design-system/icons";
import styles from "./Huddles.module.css";

type WindowProps = {
  view: HuddleView;
  act(action: HuddleAction, text?: string): void;
  error?: string | undefined;
};
export function HuddleWindowView(props: WindowProps) {
  return (
    <LayoutGroup id={useId()}>
      <HuddleWindowContent {...props} />
    </LayoutGroup>
  );
}
function HuddleWindowContent({ view, act, error }: WindowProps) {
  const focus = useHuddleRequestFocus(
    view.phase === "connected",
    view.error,
    true,
  );
  const incoming = useRef(false);
  if (view.phase === "incoming") incoming.current = true;
  else if (view.phase !== "connecting") incoming.current = false;
  const composer = useHuddleComposer(view.discussion?.composer);
  const layout = useRef<HTMLDivElement>(null);
  const call = useRef<HTMLElement>(null);
  const open = !!view.discussion;
  const [hold, setHold] = useState<{
    width: number;
    open: boolean;
  }>();
  useLayoutEffect(() => {
    if (hold && open === hold.open) setHold(undefined);
  }, [open, hold]);
  useLayoutEffect(() => {
    if (error) setHold(undefined);
  }, [error]);
  if (
    view.phase === "incoming" ||
    (view.phase === "connecting" && incoming.current)
  )
    return (
      <HuddleRequestView
        view={view}
        act={act}
        error={error || view.error}
        focus={focus}
      />
    );
  const toggleChat = () => {
    if (call.current && layout.current)
      setHold({
        width: call.current.getBoundingClientRect().width,
        open: !open,
      });
    act("thread");
  };
  return (
    <div
      ref={layout}
      className={styles.windowLayout}
      data-chat={!!view.discussion || undefined}
    >
      <main
        ref={call}
        data-buzz-ui=""
        className={styles.window}
        style={hold ? { flex: "0 0 auto", width: hold.width } : undefined}
      >
        <header className={styles.windowHeader}>
          <div className={styles.windowSettings}>
            <HuddleAudioSettings
              state={view.audioSettings}
              refresh={() => act("refreshAudio")}
              select={(kind, id) =>
                act(kind === "input" ? "inputDevice" : "outputDevice", id)
              }
            />
          </div>
          <div className={styles.windowMinimize}>
            <IconButton
              size="large"
              variant="subtle"
              aria-label="Minimize Huddle to compact controls"
              title="Minimize Huddle"
              onClick={() => act("minimize")}
              icon={<ArrowsInSimpleIcon size={22} />}
            />
          </div>
          {view.phase !== "connected" && (
            <p className="text-body text-secondary">
              {view.phase === "connecting"
                ? "Connecting your microphone…"
                : "Leaving…"}
            </p>
          )}
        </header>
        <HuddleAvatarCloud
          participants={view.participants}
          muted={view.muted}
        />
        <footer className={styles.windowFooter}>
          {error && (
            <p role="alert" className="text-caption text-secondary">
              {error}
            </p>
          )}
          <div className={styles.windowControls}>
            <IconButton
              size="large"
              variant="subtle"
              ref={focus.mute}
              aria-label={view.muted ? "Unmute" : "Mute"}
              title={view.muted ? "Unmute" : "Mute"}
              aria-pressed={view.muted}
              disabled={view.phase !== "connected"}
              onClick={() => act("mute")}
              icon={
                view.muted ? (
                  <MicrophoneSlashIcon size={22} />
                ) : (
                  <MicrophoneIcon size={22} />
                )
              }
            />
            <IconButton
              size="large"
              variant="subtle"
              aria-label="Huddle chat"
              title="Huddle chat"
              aria-expanded={!!view.discussion}
              onClick={toggleChat}
              icon={<ChatCircleIcon size={22} />}
            />
            <IconButton
              size="large"
              variant="subtle"
              data-huddle-leave=""
              aria-label="Leave huddle"
              title="Leave huddle"
              disabled={view.phase === "leaving"}
              onClick={() => act("leave")}
              icon={<PhoneDisconnectIcon size={22} />}
            />
          </div>
        </footer>
      </main>
      {view.discussion && (
        <aside
          className={styles.windowDiscussion}
          aria-label="Huddle chat panel"
        >
          <HuddleDiscussionView
            allowImageCopy={false}
            discussion={view.discussion}
            openLink={(url) => {
              if (!isBuzzLink(url)) return false;
              act("openLink", url);
              return true;
            }}
            composer={composer}
            older={() => act("older")}
            retry={() => act("retry")}
            recover={(id, dismiss) =>
              act(dismiss ? "discardMessage" : "retryMessage", id)
            }
          />
        </aside>
      )}
    </div>
  );
}
