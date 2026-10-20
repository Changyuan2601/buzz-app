import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

/** Scoped by each surface's LayoutGroup: window and toolbar never share a flight. */
export function HuddleAvatarMotion({
  participant,
  children,
  enabled = true,
}: {
  participant: string;
  children: ReactNode;
  enabled?: boolean;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.span
      {...(!reduced && enabled
        ? { layoutId: `huddle-avatar:${participant}` }
        : {})}
      data-huddle-avatar={participant}
      transition={{ layout: { duration: 0.28, ease: [0.23, 1, 0.32, 1] } }}
      style={{
        display: "grid",
        width: "100%",
        height: "100%",
        borderRadius: "50%",
      }}
    >
      {children}
    </motion.span>
  );
}
