import { useCallback, useSyncExternalStore } from "react";
import { LinkLabel } from "../links/InlineLink";
import inlineStyles from "../../shared/InlineReference.module.css";
import { describePull, stateIcons } from "./pull-state-view";
import type { PullStates } from "./pull-states";
import styles from "./GitHub.module.css";

/** A pull request link in a message: the Links label with the pull request's
 * state as its icon, in place of the GitHub logo. */
export function PullLink({ url, states }: { url: string; states: PullStates }) {
  const subscribe = useCallback(
    (listener: () => void) => states.watch(url, listener),
    [states, url],
  );
  const read = useSyncExternalStore(subscribe, () => states.get(url));
  const state = typeof read === "object" ? read : undefined;
  // The plain pull request glyph until read, and when it can't be, so the
  // icon doesn't swap when the state arrives.
  const Icon = stateIcons[state?.state ?? "open"];
  return (
    <LinkLabel
      href={url}
      icon={
        <span
          className={styles.pullState}
          data-pr-state={state?.state ?? "unknown"}
          title={describePull({ state, failed: read === "failed" })}
        >
          <Icon aria-hidden="true" className={inlineStyles.icon} />
        </span>
      }
    />
  );
}
