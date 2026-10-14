import { useId, useState } from "react";
import { enteredRelayOrigin } from "../communities/destination";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";

function originOf(url: string) {
  try {
    return enteredRelayOrigin(url);
  } catch {
    return undefined;
  }
}

/**
 * The community URL field with its Join button, shared by the first-run
 * landing and Join a community. Join is enabled while the typed address
 * normalizes; submitting an invalid one shows the error under the field.
 */
export function CommunityUrlField({
  url,
  onUrlChange,
  onSubmit,
  disabled = false,
}: {
  url: string;
  onUrlChange: (url: string) => void;
  /** Receives the canonical secure origin the typed address normalizes to. */
  onSubmit: (origin: string) => void;
  disabled?: boolean;
}) {
  const [invalid, setInvalid] = useState(false);
  const errorId = useId();
  const origin = originOf(url);
  const submit = () => {
    if (origin) onSubmit(origin);
    else setInvalid(true);
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <Field label="Community URL" invalid={invalid} disabled={disabled}>
            <Input
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="relay.example.com"
              value={url}
              disabled={disabled}
              aria-describedby={invalid ? errorId : undefined}
              onChange={(event) => {
                onUrlChange(event.target.value);
                setInvalid(false);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing)
                  return;
                event.preventDefault();
                submit();
              }}
            />
          </Field>
        </div>
        <Button
          variant="primary"
          disabled={disabled || !origin}
          onClick={submit}
        >
          Join
        </Button>
      </div>
      {invalid && (
        <p id={errorId} role="alert" className="m-0 text-body-sm text-danger">
          Please enter a valid community URL
        </p>
      )}
    </div>
  );
}
