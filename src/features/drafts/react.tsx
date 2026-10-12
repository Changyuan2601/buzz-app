import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { useDraftProtection } from "./DraftProtection";
import type { DraftState } from "./guard";

const Scope = createContext<object | undefined>(undefined);
export function DraftScope({
  scope,
  children,
}: {
  scope: object;
  children: ReactNode;
}) {
  return <Scope.Provider value={scope}>{children}</Scope.Provider>;
}
export const useDraftScope = () => useContext(Scope);

/** Registers state only; the editor continues to own its draft and Save. */
export function useDraftState(
  label: string,
  state: DraftState,
  discard: () => void,
) {
  const guard = useDraftProtection();
  const scope = useDraftScope();
  const reset = useRef(discard);
  reset.current = discard;
  const registration = useRef<
    ReturnType<NonNullable<typeof guard>["register"]> | undefined
  >(undefined);
  useLayoutEffect(() => {
    if (!guard || !scope) return;
    const entry = guard.register(scope, label, () => reset.current());
    registration.current = entry;
    return () => {
      registration.current = undefined;
      entry.dispose();
    };
  }, [guard, scope, label]);
  useLayoutEffect(() => {
    registration.current?.update(state);
  });
}
