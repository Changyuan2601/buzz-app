import { useSyncExternalStore } from "react";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { InlineHeader } from "../shared/design-system/ui/Header";
import { Accordion } from "../shared/design-system/ui/Accordion";
import { lengthRefusals } from "../features/developer/length-refusals";
import { SHOWN_WORDS } from "../buzz-mcp/tools";
import styles from "./DeveloperSettings.module.css";

const AUDIENCES = [
  ["everyone", `Everyone messages over ${SHOWN_WORDS.everyone} words`],
  ["details", `Details briefs over ${SHOWN_WORDS.details} words`],
] as const;

/** Temporary: how often `send` refused a message as too long since launch,
 * with the latest examples, while its limits are tuned. */
export function LengthRefusalsPanel() {
  const { counts, recent } = useSyncExternalStore(
    lengthRefusals.subscribe,
    lengthRefusals.snapshot,
  );
  return (
    <section aria-labelledby="length-refusals-title" className="space-y-2">
      <InlineHeader
        id="length-refusals-title"
        title="Length refusals"
        subtitle="Messages agents' send refused as too long since Buzz opened. Not saved."
      />
      <SettingsGroup layout="form">
        <dl className={styles.metrics}>
          {AUDIENCES.map(([audience, label]) => (
            <div key={audience}>
              <dt className="text-body-sm text-muted">{label}</dt>
              <dd className="m-0 text-heading tabular-nums">
                {counts[audience].toLocaleString()}
              </dd>
            </div>
          ))}
        </dl>
      </SettingsGroup>
      {recent.length > 0 && (
        <Accordion
          items={[
            {
              value: "examples",
              title: `Latest ${recent.length === 1 ? "example" : `${recent.length} examples`}`,
              content: (
                <ul className="m-0 list-none space-y-3 p-0">
                  {recent.map((refusal) => (
                    <li key={`${refusal.at}-${refusal.audience}`}>
                      <p className="m-0 text-body-sm text-muted tabular-nums">
                        {refusal.audience === "details"
                          ? "Details brief"
                          : "Everyone"}
                        , {refusal.words} words,{" "}
                        {new Date(refusal.at).toLocaleTimeString()}
                      </p>
                      <p className="m-0 whitespace-pre-wrap text-body-sm">
                        {refusal.text}
                      </p>
                    </li>
                  ))}
                </ul>
              ),
            },
          ]}
        />
      )}
    </section>
  );
}
