import { useEffect, useState } from "react";
import type { RelaySession } from "../relay/session";
import {
  CaretUpIcon,
  FolderSimpleIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";

export function SessionProjectControl({
  session,
  value,
  onChange,
  channelId,
  disabled = false,
}: {
  session: RelaySession;
  value?: string | undefined;
  onChange?: ((projectId: string) => void) | undefined;
  channelId?: string | undefined;
  disabled?: boolean;
}) {
  const [snapshot, setSnapshot] = useState(() =>
    session.mePreferences.snapshot(),
  );
  useEffect(() => {
    const subscribe = session.mePreferences.subscribe;
    if (typeof subscribe !== "function") return;
    return subscribe(() => setSnapshot(session.mePreferences.snapshot()));
  }, [session]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const projectId =
    value ??
    (channelId ? snapshot.data?.assignments[channelId] : undefined) ??
    "";
  const project = snapshot.data?.sections.find((item) => item.id === projectId);
  const choose = (next: string) => {
    setError("");
    if (onChange) {
      onChange(next);
      return;
    }
    if (!channelId) return;
    setBusy(true);
    void session.mePreferences
      .assign(channelId, next || undefined)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <span>
      <MenuRoot>
        <MenuTrigger
          disabled={
            disabled ||
            busy ||
            snapshot.status === "idle" ||
            snapshot.status === "loading"
          }
          aria-label={`Project: ${project?.name ?? "No project"}`}
          render={(props) => (
            <Button {...props} variant="ghost" size="sm">
              <FolderSimpleIcon size={16} aria-hidden="true" />
              <span>{project?.name ?? "No project"}</span>
              <CaretUpIcon size={12} aria-hidden="true" />
            </Button>
          )}
        />
        <MenuPopup side="top" align="end" aria-label="Choose project">
          <MenuRadioGroup value={projectId} onValueChange={choose}>
            <MenuRadioItem value="" closeOnClick>
              No project
            </MenuRadioItem>
            {(snapshot.data?.sections ?? []).map((item) => (
              <MenuRadioItem key={item.id} value={item.id} closeOnClick>
                {item.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          {snapshot.status === "error" && (
            <MenuItem onClick={() => void session.mePreferences.refresh()}>
              Retry projects
            </MenuItem>
          )}
        </MenuPopup>
      </MenuRoot>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
