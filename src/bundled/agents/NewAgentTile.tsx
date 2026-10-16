import type { ComponentProps, Ref } from "react";
import { CaretDownIcon } from "../../shared/design-system/icons";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { Button } from "../../shared/design-system/ui/Button";
import { agentAvatars } from "../../features/agents/avatar-packs";
import styles from "./AgentCard.module.css";

const artwork = [
  "gloopies-3",
  "fuzzies-1",
  "pollies-23",
  "gloopies-20",
  "pollies-25",
  "fuzzies-4",
  "pollies-24",
  "fuzzies-18",
];
export function NewAgentTile({
  fullWidth = false,
  variant = "tile",
  labelRef,
  label = "New agent",
  ...props
}: Omit<ComponentProps<typeof SurfaceButton>, "className" | "children"> & {
  /** What the tile makes, such as New team. */
  label?: string;
  fullWidth?: boolean;
  variant?: "tile" | "button";
  labelRef?: Ref<HTMLSpanElement>;
}) {
  if (variant === "button")
    return (
      <Button {...props} type="button" variant="prominent" size="sm">
        {label}
        <CaretDownIcon
          size={14}
          className="buzz-dropdown-chevron"
          aria-hidden="true"
        />
      </Button>
    );
  return (
    <SurfaceButton
      {...props}
      type="button"
      className={styles.newTile}
      data-full-width={fullWidth || undefined}
    >
      <span aria-hidden="true" className={styles.newArtwork}>
        {(fullWidth
          ? agentAvatars
              .filter(
                (_, index) =>
                  index % Math.max(1, Math.floor(agentAvatars.length / 12)) ===
                  0,
              )
              .slice(0, 12)
              .map((avatar) => avatar.id)
          : artwork
        ).flatMap((id) => {
          const avatar = agentAvatars.find((item) => item.id === id);
          return avatar?.preview
            ? [<img key={id} src={avatar.preview} alt="" />]
            : [];
        })}
      </span>
      <span ref={labelRef} className={`${styles.newLabel} text-label-sm`}>
        {label}
      </span>
    </SurfaceButton>
  );
}
