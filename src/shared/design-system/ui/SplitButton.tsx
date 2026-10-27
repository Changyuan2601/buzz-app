import { CaretDownIcon } from "../icons/index";
import type { ReactNode } from "react";
import { Button, type ButtonProps } from "./Button";
import { MenuPopup, MenuRoot, MenuTrigger } from "./Menu";

export type SplitButtonProps = Pick<ButtonProps, "onClick" | "aria-label"> & {
  /** The main action's label, which names the menu's current choice. */
  children: ReactNode;
  /** Names the menu button, such as "Choose agent type". */
  menuLabel: string;
  /** The menu's items: choices that change what the main action does. */
  menu: ReactNode;
  variant?: "subtle" | "outline" | "prominent";
  size?: "sm" | "md";
  loading?: boolean | undefined;
  disabled?: boolean | undefined;
};

/** An action joined to a menu of choices for it. The action runs with the
 * chosen option; choosing in the menu changes the option, not runs it. */
export function SplitButton({
  children,
  menuLabel,
  menu,
  variant = "subtle",
  size = "md",
  loading = false,
  disabled = false,
  ...props
}: SplitButtonProps) {
  return (
    <div data-buzz-ui="" className="buzz-split-button" data-variant={variant}>
      <Button
        {...props}
        variant={variant}
        size={size}
        loading={loading}
        disabled={disabled}
      >
        {children}
      </Button>
      <MenuRoot>
        <MenuTrigger
          render={
            <Button
              variant={variant}
              size={size}
              shape="icon"
              aria-label={menuLabel}
              // A choice made while the action runs would not be the one it used.
              disabled={disabled || loading}
            >
              <CaretDownIcon aria-hidden="true" />
            </Button>
          }
        />
        <MenuPopup align="end">{menu}</MenuPopup>
      </MenuRoot>
    </div>
  );
}
