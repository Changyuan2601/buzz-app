import { createContext, useLayoutEffect, useRef } from "react";

export type DetailTab = {
  id: string;
  title: string;
  node: HTMLElement;
  close(): void;
};
/** The conversation workspace owns promotion; the reader keeps its live content. */
export const DetailTabContext = createContext<
  ((tab: DetailTab) => () => void) | undefined
>(undefined);

export function DetailTabSlot({ node }: { node: HTMLElement }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const parent = slot.current;
    if (!parent) return;
    const scrollers = [node, ...node.querySelectorAll<HTMLElement>("*")]
      .filter((element) => element.scrollTop || element.scrollLeft)
      .map((element) => ({
        element,
        top: element.scrollTop,
        left: element.scrollLeft,
      }));
    parent.append(node);
    for (const { element, top, left } of scrollers) {
      element.scrollTop = top;
      element.scrollLeft = left;
    }
    return () => {
      if (node.parentElement === parent) node.remove();
    };
  }, [node]);
  return (
    <div
      ref={slot}
      style={{
        display: "flex",
        flex: 1,
        minHeight: 0,
        flexDirection: "column",
      }}
    />
  );
}
