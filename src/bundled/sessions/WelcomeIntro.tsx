import { useSyncExternalStore, type ReactNode } from "react";
import type { RegisteredAgentType } from "../../features/agents/service";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Header } from "../../shared/design-system/ui/Header";
import { Composer } from "../../shared/design-system/ui/Composer";
import { CheckIcon, RobotIcon } from "../../shared/design-system/icons";
import messageStyles from "../../features/messages/Messages.module.css";
import styles from "./SoloWelcome.module.css";

/** Prepared app content with the ordinary received-message presentation, not a relay event. */
export function WelcomeIntro({ children }: { children?: ReactNode }) {
  return (
    <div className={styles.intro}>
      <div className={styles.welcomeHeading}>
        <Header
          title={
            <span className={`${styles.welcomeTitle} text-display`}>
              Welcome to Buzz
            </span>
          }
          level={1}
        />
      </div>
      <div className={messageStyles.message} data-layout="timeline">
        <span className={messageStyles.messageGutter} />
        <div className={messageStyles.messageBody}>
          <div className={messageStyles.messageContent}>
            <div className={messageStyles.messageAvatar}>
              <Avatar
                shape="squircle"
                size="large"
                alt="Welcome placeholder"
                fallback="Welcome"
                fallbackContent={<RobotIcon size={24} aria-hidden="true" />}
              />
            </div>
            <div className={messageStyles.byline}>
              <strong className={messageStyles.author}>Welcome</strong>
            </div>
            <div className={messageStyles.messageBubble} data-long-text>
              <p className="text-message">
                This is a space to think things through, ask questions, and get
                work done with your agents. Start by connecting your AI
                provider.
              </p>
            </div>
          </div>
        </div>
      </div>
      {children && <div className={styles.introExtras}>{children}</div>}
    </div>
  );
}

/** No draft, recipient, upload or publication capability exists until setup is confirmed. */
export function WelcomeComposer({ phase }: { phase: "connect" | "customize" }) {
  const prompt =
    phase === "connect"
      ? "Connect your AI provider to start chatting"
      : "Choose a name and select Looks good to start chatting";
  return (
    <div className={styles.lockedComposer}>
      <Composer
        value=""
        onValueChange={() => {}}
        disabled
        label="Message your agent"
        placeholder={phase === "connect" ? prompt : "Message your agent"}
        status={phase === "customize" ? prompt : undefined}
      />
    </div>
  );
}

/** Current provider evidence without starting a second readiness check. */
export function WelcomeConnected({ type }: { type: RegisteredAgentType }) {
  const provider = type.provider;
  const health = useSyncExternalStore(
    provider?.subscribe ?? (() => () => {}),
    provider?.snapshot ?? (() => undefined),
  );
  const ready = health?.readiness === "ready";
  const Icon = type.icon;
  return (
    <div className={styles.connected}>
      {Icon && <Icon size={18} aria-hidden="true" />}
      <span className="text-label-sm">{type.title}</span>
      <span className="text-body-sm text-subtle">
        {ready
          ? "Connected"
          : health?.readiness === "checking"
            ? "Checking…"
            : "Needs setup"}
      </span>
      {ready && <CheckIcon size={16} aria-hidden="true" />}
    </div>
  );
}
