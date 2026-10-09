import { Button } from "../../shared/design-system/ui/Button";
import { isWorkflowOperation } from "../../features/workflows/protocol";
import { useState, useSyncExternalStore } from "react";
import type { RelayProfiler } from "../../features/relay/profiling";
import { RelayTimings } from "./RelayTimings";
import { PRODUCT_FEEDBACK_KIND } from "../../features/relay/product-feedback";
import { isSessionLinkReceipt } from "../../features/sessions/share";
import type { Outbox } from "../../features/relay/outbox";

/** Delivery belongs to the session, including messages from other pages or a previous launch. */
export function OutboxStatus({
  outbox,
  profiling,
}: {
  outbox: Outbox;
  profiling: RelayProfiler;
}) {
  const operations = useSyncExternalStore(
    outbox.subscribe,
    outbox.snapshot,
    outbox.snapshot,
  ).filter((item) => item.event.kind !== PRODUCT_FEEDBACK_KIND);
  const [error, setError] = useState<string>();

  return (
    <details>
      <summary>Outbox · {operations.length} items</summary>
      <p>Removing an item from the outbox does not delete a sent message.</p>
      <ul
        style={{
          maxHeight: "10rem",
          overflow: "auto",
          paddingInlineStart: "1.2rem",
        }}
      >
        {operations.map((item) => (
          <li key={item.event.id}>
            <span>
              {item.event.kind === 9000
                ? `Add agent ${item.event.tags.find(([tag]) => tag === "p")?.[1]?.slice(0, 12) ?? ""}`
                : item.event.content.slice(0, 100)}{" "}
              ·{" "}
              {
                {
                  sending: "Sending",
                  accepted: "Sent",
                  unknown: "Unconfirmed",
                  failed: "Not sent",
                  seen: "Sent",
                }[item.delivery]
              }
            </span>{" "}
            {!isWorkflowOperation(item.event) &&
              !item.guarded &&
              (item.delivery === "failed" || item.delivery === "unknown") && (
                <Button
                  type="button"
                  onClick={() => outbox.retry(item.event.id)}
                >
                  Retry
                </Button>
              )}{" "}
            {item.guarded &&
              (item.delivery === "failed" || item.delivery === "unknown") && (
                <span>
                  Retry from the channel or agent profile after checking
                  membership.
                </span>
              )}{" "}
            {item.delivery !== "sending" && (
              <Button
                type="button"
                onClick={async () => {
                  try {
                    const shareReceipt =
                      item.event.kind === 9 &&
                      (/^snapshot-share:(agent|team):.+$/.test(
                        item.recovery?.key ?? "",
                      ) ||
                        isSessionLinkReceipt(item)) &&
                      (item.delivery === "accepted" ||
                        item.delivery === "seen");
                    if (shareReceipt) await outbox.acknowledge(item.event.id);
                    await outbox.dismiss(item.event.id);
                    setError(undefined);
                  } catch (reason) {
                    setError(String(reason));
                  }
                }}
              >
                Remove from outbox
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
      <RelayTimings profiling={profiling} />
    </details>
  );
}
