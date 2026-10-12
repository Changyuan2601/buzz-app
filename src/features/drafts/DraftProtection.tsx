import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import type { DraftGuard } from "./guard";

const Context = createContext<DraftGuard | undefined>(undefined);
export const useDraftProtection = () => useContext(Context);

/** One prompt owner per app, shared by navigation and local editor hosts. */
export function DraftProtection({
  guard,
  children,
}: {
  guard: DraftGuard;
  children: ReactNode;
}) {
  const notice = useSyncExternalStore(
    guard.subscribe,
    guard.snapshot,
    guard.snapshot,
  );
  return (
    <Context.Provider value={guard}>
      {children}
      <Dialog
        open={!!notice}
        onOpenChange={(open) => {
          if (!open) guard.cancel();
        }}
        title={
          notice?.saving
            ? "Changes are being saved"
            : "Discard unsaved changes?"
        }
        description={
          notice?.saving
            ? "Stay here until saving finishes, then try again."
            : `Your unsaved changes to ${notice?.label ?? "this editor"} will be lost.`
        }
        actions={
          <>
            <Button onClick={guard.cancel}>
              {notice?.saving ? "Stay here" : "Keep editing"}
            </Button>
            {!notice?.saving && (
              <Button variant="destructive" onClick={guard.discard}>
                Discard changes
              </Button>
            )}
          </>
        }
      >
        <span />
      </Dialog>
    </Context.Provider>
  );
}
