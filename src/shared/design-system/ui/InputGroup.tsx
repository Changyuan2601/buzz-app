import type { ReactNode, ComponentProps } from "react";

/** Shared frame for SearchField and Combobox; the native control keeps focus. */
export function InputGroup({
  children,
  leading,
  trailing,
  surface = "inset",
  ...props
}: Omit<ComponentProps<"div">, "className"> & {
  surface?: "inset" | "panel";
  children?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div
      {...props}
      data-buzz-ui=""
      data-surface={surface}
      className="buzz-input-group"
    >
      {leading && <span className="buzz-input-leading">{leading}</span>}
      {children}
      {trailing !== undefined && (
        <span className="buzz-input-trailing">{trailing}</span>
      )}
    </div>
  );
}
