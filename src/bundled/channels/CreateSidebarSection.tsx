import { useId, useRef, useState, type ComponentProps } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Input } from "../../shared/design-system/ui/Input";

/** Mounted after the launching menu closes, so focus has one modal owner. */
export function CreateSidebarSection({
  channelName,
  create,
  close,
  writable,
  refreshing,
  retry,
  finalFocus = false,
}: {
  channelName?: string | undefined;
  /** True only after the session accepts the move or confirms empty creation. */
  create: (section: { id: string; name: string }) => boolean | Promise<boolean>;
  close: () => void;
  writable: boolean;
  refreshing: boolean;
  retry: () => Promise<void>;
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
}) {
  const formId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const submitted = useRef(false);
  const sectionId = useRef<string | undefined>(undefined);
  const [blocked, setBlocked] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (submitted.current || pending || !name.trim()) return;
    submitted.current = true;
    sectionId.current ??= crypto.randomUUID();
    setPending(true);
    setError("");
    try {
      const accepted = await create({
        id: sectionId.current,
        name: name.trim(),
      });
      submitted.current = accepted;
      setBlocked(!accepted);
    } catch (cause) {
      submitted.current = false;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      size="compact"
      headerGap="compact"
      footerGap="compact"
      dismissOnOutsideClick
      preventClose={pending}
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={channelName ? "Move to new section" : "Create new section"}
      initialFocus={input}
      finalFocus={finalFocus}
      actions={
        <>
          <Button disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button
            form={formId}
            type="submit"
            variant="prominent"
            disabled={!name.trim()}
            loading={pending}
          >
            {channelName ? "Create and move" : "Create"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          ref={input}
          aria-label="Section name"
          placeholder="Section name"
          required
          disabled={pending}
          maxLength={256}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </form>
      {error && <p role="alert">{error}</p>}
      {blocked && !writable && (
        <div role="alert">
          <p>
            Saved preferences are unavailable. Retry preferences to keep
            creating this section.
          </p>
          <Button disabled={refreshing} onClick={() => void retry()}>
            Retry preferences
          </Button>
        </div>
      )}
    </Dialog>
  );
}
