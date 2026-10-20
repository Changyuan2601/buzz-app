import { Composer } from "../../shared/design-system/ui/Composer";
import styles from "./SoloWelcome.module.css";

/** No draft, recipient, upload or publication capability exists until setup is confirmed. */
export function WelcomeComposer({ phase }: { phase: "connect" | "customize" }) {
  return (
    <div className={styles.lockedComposer}>
      <Composer
        value=""
        onValueChange={() => {}}
        disabled
        label="Message your agent"
        placeholder={
          phase === "connect"
            ? "Connect your AI provider to start chatting"
            : "Message your agent"
        }
      />
    </div>
  );
}
