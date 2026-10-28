import {
  Children,
  type ElementType,
  isValidElement,
  type ReactNode,
} from "react";

/** jsdom has no layout for Virtua to window by. This stand-in for `virtua`
 * mounts every child through the caller's item component; windowing itself is
 * covered in Playwright. Use with `vi.mock("virtua", () => import(...))`. */
export function Virtualizer({
  children,
  as: List = "div",
  item: Item = "div",
}: {
  children: ReactNode;
  as?: ElementType;
  item?: ElementType;
}) {
  return (
    <List>
      {Children.toArray(children).map((child, index) => (
        <Item
          key={isValidElement(child) ? child.key : index}
          style={{}}
          {...(typeof Item === "string" ? {} : { index })}
        >
          {child}
        </Item>
      ))}
    </List>
  );
}
