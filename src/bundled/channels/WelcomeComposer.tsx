import { Composer } from "../../shared/design-system/ui/Composer";
import styles from "./SoloWelcome.module.css";

/** No draft, recipient, upload or publication capability exists until a provider is connected. */
export function WelcomeComposer() {
  return (
    <div className={styles.lockedComposer}>
      <Composer
        value=""
        onValueChange={() => {}}
        disabled
        label="Message your agent"
        placeholder="Connect your AI provider to start chatting"
      />
    </div>
  );
}
