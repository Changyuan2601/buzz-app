import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps, ReactNode } from "react";

type FrameProps = Omit<
  Pick<
    ComponentProps<"div">,
    "onClick" | "onDoubleClick" | "tabIndex" | "id" | "aria-label"
  >,
  "className" | "style" | "title" | "role" | "aria-selected" | "children"
> & {
  artwork?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
};

type CollectionCardProps = FrameProps &
  (
    | { role: "option"; selected: boolean; action?: never; children?: never }
    | { role: "button"; selected?: never; action?: never; children?: never }
    | {
        role?: never;
        selected?: never;
        action?: ReactNode;
        children?: ReactNode;
      }
  );

/** A collection's visual frame, not a navigation or selection controller.
 * Listbox callers own keys and focus; an option cannot contain an independent
 * action. Static cards can compose real controls in children and the action slot.
 */
export function CollectionCard({
  artwork,
  title,
  description,
  children,
  action,
  role,
  selected,
  ...props
}: CollectionCardProps) {
  const content = (
    <>
      <div className="buzz-collection-card-content">
        {artwork && (
          <div className="buzz-collection-card-artwork">{artwork}</div>
        )}
        {(title || description) && (
          <div className="buzz-collection-card-copy">
            {title && <div className="buzz-collection-card-title">{title}</div>}
            {description && (
              <div className="buzz-collection-card-description">
                {description}
              </div>
            )}
          </div>
        )}
        {children}
      </div>
      {action && <div className="buzz-collection-card-action">{action}</div>}
    </>
  );
  if (role === "button")
    return (
      <BaseButton
        nativeButton={false}
        render={<div {...props} />}
        data-buzz-ui=""
        className="buzz-collection-card"
        data-interactive=""
      >
        {content}
      </BaseButton>
    );
  return (
    <div
      {...props}
      data-buzz-ui=""
      className="buzz-collection-card"
      {...(role === "option"
        ? { role: "option", "aria-selected": selected }
        : {})}
    >
      {content}
    </div>
  );
}
