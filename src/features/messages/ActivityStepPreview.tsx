import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import styles from "./ActivityStepPreview.module.css";

/** The request's typing footprint opens into its real current step. */
export function ActivityStepPreview({
  text,
  state,
}: {
  text?: string | undefined;
  state: "waiting" | "working";
}) {
  const characters = Array.from(text?.replace(/\s+/g, " ").trim() ?? "");
  const label =
    characters.length > 280
      ? `${characters.slice(0, 279).join("")}…`
      : characters.join("");
  return (
    <span className={styles.stepPreview}>
      {!label ? (
        <TypingDots size="message" state={state} />
      ) : (
        <span className={styles.stepText}>
          <ShimmerText active={state === "working"}>{label}</ShimmerText>
        </span>
      )}
    </span>
  );
}
