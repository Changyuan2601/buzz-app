import { useRef, useState } from "react";
import { npubEncode } from "nostr-tools/nip19";
import { useFileDrop } from "../messages/use-file-drop";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { classifyKeyImport, readKeyFile } from "./key-import";
import { SetupProgress } from "./SetupProgress";

/**
 * Pause for a key the user already has: paste or type an `nsec1…` key, or
 * drop or choose a small text file holding one. Valid input previews the
 * npub; Continue hands the nsec to native import. The key exists only in this
 * component's state and is never logged or stored, so leaving the page
 * discards it. While import runs the form gives way to the progress page but
 * stays mounted, so a native refusal returns to it with the typed key kept.
 * With `expectedPubkey`, only that key continues: any other valid nsec is
 * refused under the field.
 */
export function KeyImport({
  expectedPubkey,
  onBack,
  onImport,
}: {
  /** The hex key linked to the signed-in account, when the lane has one. */
  expectedPubkey?: string | undefined;
  onBack: () => void;
  /** Rejects with the native refusal, shown under the field. */
  onImport: (nsec: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const form = useRef<HTMLFormElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const input = classifyKeyImport(text);
  const expected =
    expectedPubkey === undefined ? undefined : npubEncode(expectedPubkey);
  const mismatch =
    input.kind === "nsec" && expected !== undefined && input.npub !== expected;
  const ready = input.kind === "nsec" && !mismatch;
  const change = (next: string) => {
    setText(next);
    setFailure(undefined);
    // Masked by default must re-assert for the next key pasted.
    if (!next.trim()) setRevealed(false);
  };
  const fromFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      change(await readKeyFile(file));
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "Couldn’t read that file.",
      );
    }
  };
  // The whole form is the drop target; the hook rebinds when the form returns.
  const dragging = useFileDrop(form, !busy, (files) => void fromFile(files[0]));
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await onImport(input.nsec);
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "Couldn’t import this key.",
      );
    } finally {
      setBusy(false);
    }
  };
  if (busy) return <SetupProgress label="Importing your key…" />;
  const message =
    failure ??
    (mismatch
      ? `That isn’t the key linked to this account. It expects ${expected} (the key on your other device).`
      : input.kind === "encrypted"
        ? "Password-protected backups aren’t supported here yet. Paste the nsec1 key itself."
        : input.kind === "invalid"
          ? "That doesn’t look like a valid nsec. Paste an nsec1 key."
          : undefined);
  return (
    <form
      ref={form}
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div>
        <h1 id="welcome-title" className="text-title text-primary">
          Enter your private key
        </h1>
        <p className="mt-2 text-body text-secondary">
          Paste your private key to sign in to Buzz. You can also drop a text
          file holding it here, or choose one.
        </p>
      </div>
      {/* Unstyled wireframe: a plain border until the key panel gets a design. */}
      <div className="flex flex-col gap-3 rounded-lg border border-standard p-3">
        <Field
          label="Private key (nsec)"
          error={message}
          description={
            input.kind === "nsec" && (
              <>
                Public identity:{" "}
                <code className="select-text break-all font-mono text-mono">
                  {input.npub}
                </code>
              </>
            )
          }
        >
          <Input
            type={revealed ? "text" : "password"}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="nsec1…"
            value={text}
            onValueChange={change}
            autoFocus
          />
        </Field>
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            size="sm"
            disabled={!text}
            onClick={() => setRevealed(!revealed)}
          >
            {revealed ? "Hide private key" : "Reveal private key"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => picker.current?.click()}
          >
            Choose a key file
          </Button>
        </div>
        <p className="m-0 text-body-sm text-secondary">
          {dragging
            ? "Drop to use this file."
            : "A key file is a small text file whose first line is the nsec1 key."}
        </p>
        <input
          ref={picker}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-label="Key file"
          accept=".txt,.key,text/plain"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void fromFile(file);
          }}
        />
      </div>
      {/* Footer order: secondary first, primary last. */}
      <div className="flex gap-3">
        <Button type="button" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" variant="primary" disabled={!ready}>
          Continue with this key
        </Button>
      </div>
    </form>
  );
}
