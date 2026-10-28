import { useCallback, useContext, useSyncExternalStore } from "react";
import { LinkInteractiveContext } from "../../features/conversation/LinkLabelContext";
import { LinkLabel } from "../links/InlineLink";
import inlineStyles from "../../shared/InlineReference.module.css";
import { describePull, stateIcons } from "./pull-state-view";
import type { PullStates } from "./pull-states";
import styles from "./GitHub.module.css";

/** A pull request link in a message: the Links label with the pull request's
 * state as its icon, in place of the GitHub logo. */
export function PullLink({ url, states }: { url: string; states: PullStates }) {
  // A composer decoration or preview shows what is already known and reads
  // nothing: typing a link mounts one for every prefix of its number.
  const live = useContext(LinkInteractiveContext);
  const subscribe = useCallback(
    (listener: () => void) => (live ? states.watch(url, listener) : () => {}),
    [live, states, url],
  );
  const read = useSyncExternalStore(subscribe, () => states.get(url));
  const state = typeof read === "object" ? read : undefined;
  // The plain pull request glyph until read, and when it can't be, so the
  // icon doesn't swap when the state arrives.
  const Icon = stateIcons[state?.state ?? "open"];
  const words = describePull({ state, failed: read === "failed" });
  return (
    <LinkLabel
      href={url}
      icon={
        <span
          className={styles.pullState}
          data-pr-state={state?.state ?? "unknown"}
          role="img"
          aria-label={words}
          title={words}
        >
          <Icon aria-hidden="true" className={inlineStyles.icon} />
        </span>
      }
    />
  );
}
