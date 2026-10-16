import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const ProviderDialogFooter = createContext<HTMLElement | null>(null);

/** Provider actions use the host modal's footer, with an inline fallback. */
export function ProviderDialogActions({ children }: { children: ReactNode }) {
  const footer = useContext(ProviderDialogFooter);
  return footer ? (
    createPortal(children, footer)
  ) : (
    <div className="flex justify-end gap-2">{children}</div>
  );
}
