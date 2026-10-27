import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "../../shared/design-system/ui/Button";
import { ScrollEdgeMaterial } from "../../shared/design-system/ui/ScrollEdgeMaterial";
import styles from "./AgentSaveButton.module.css";

/** The agent sidebar supplies a footer; other hosts retain their inline action. */
export const AgentSaveFooter = createContext<{
  target: HTMLElement | null;
  notice?: ReactNode;
} | null>(null);

export function AgentSaveButton({
  form,
  saving,
  disabled,
}: {
  form: string;
  saving: boolean;
  disabled: boolean;
}) {
  const footer = useContext(AgentSaveFooter);
  const reducedMotion = useReducedMotion();
  const visible = !disabled || saving;
  const instant =
    reducedMotion ||
    document.documentElement.hasAttribute("data-keyboard-navigation");
  const transition = {
    duration: instant ? 0 : 0.22,
    ease: [0.23, 1, 0.32, 1] as const,
  };
  const button = (
    <Button
      type="submit"
      form={form}
      variant="prominent"
      loading={saving}
      disabled={disabled}
      focusableWhenDisabled
      style={footer?.target ? { width: "100%" } : undefined}
    >
      {saving ? "Saving…" : "Save"}
    </Button>
  );
  return footer?.target
    ? createPortal(
        <motion.div
          className={styles.frame}
          initial={false}
          animate={{
            height: visible ? "auto" : 0,
            opacity: visible ? 1 : 0,
            "--footer-open": visible ? 1 : 0,
          }}
          transition={transition}
          inert={!visible}
          aria-hidden={!visible || undefined}
        >
          <ScrollEdgeMaterial edge="bottom" />
          <motion.div
            className={styles.footer}
            initial={false}
            animate={{ y: visible ? "0rem" : "0.5rem" }}
            transition={transition}
          >
            {footer.notice}
            {button}
          </motion.div>
        </motion.div>,
        footer.target,
      )
    : visible && <div>{button}</div>;
}
