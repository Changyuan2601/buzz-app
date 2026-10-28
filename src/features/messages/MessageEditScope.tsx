import {
  createContext,
  useContext,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import type { ChannelMessage } from "../relay/contracts";

type EditHandler = (row: ChannelMessage) => void;
type EditScopeValue = {
  current: EditHandler | undefined;
  input: RefObject<HTMLElement | null>;
  focusTarget(): HTMLElement | null;
  exactRows?: (() => readonly ChannelMessage[]) | undefined;
};
const EditScope = createContext<EditScopeValue | undefined>(undefined);

/** A timeline and its composer share a target; nested threads/viewers own their scope. */
export function MessageEditScope({
  children,
  exactRows,
}: {
  children: ReactNode;
  /** Rows the composer may edit, read when editing starts. */
  exactRows?: (() => readonly ChannelMessage[]) | undefined;
}) {
  const parent = useContext(EditScope);
  const scope = useRef<EditScopeValue>({
    current: undefined,
    input: { current: null },
    focusTarget(): HTMLElement | null {
      const input = scope.current.input.current;
      return input?.isConnected ? input : (parent?.focusTarget() ?? null);
    },
  });
  // The scope stays one object, so changing rows never re-render its readers.
  scope.current.exactRows = exactRows;
  return (
    <EditScope.Provider value={scope.current}>{children}</EditScope.Provider>
  );
}
export const useMessageEditScope = () => useContext(EditScope);
