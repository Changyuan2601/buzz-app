import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import type { ComposerCaptureProps } from "../conversation/contracts";
import { MAX_ATTACHMENT_FILES, type AttachmentDraft } from "./attachment-draft";

/** Unaccepted microphone capture is revoked with its composer; accepted files use the shared draft. */
export function useVoiceCapture(
  store: AttachmentDraft,
  disabled: boolean,
  report: (error: string) => void,
) {
  const [capture, setCapture] = useState<{
    component: ComponentType<ComposerCaptureProps>;
    token: object;
  }>();
  const current = useRef(capture);
  const live = useRef(false);
  const blocked = useRef(disabled);
  blocked.current = disabled;
  const cancel = useCallback(() => {
    current.current = undefined;
    setCapture(undefined);
  }, []);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      current.current = undefined;
    };
  }, []);
  useLayoutEffect(() => {
    if (disabled) cancel();
  }, [disabled, cancel]);
  function begin(component: ComponentType<ComposerCaptureProps>) {
    if (
      !live.current ||
      blocked.current ||
      current.current ||
      store.snapshot().some((item) => item.voice)
    )
      return false;
    if (store.snapshot().length >= MAX_ATTACHMENT_FILES) {
      report(`Attach at most ${MAX_ATTACHMENT_FILES} files per message.`);
      return false;
    }
    const value = { component, token: {} };
    current.current = value;
    setCapture(value);
    return () => {
      if (current.current === value) cancel();
    };
  }
  const Capture = capture?.component;
  return {
    begin,
    capturing: !!capture,
    isCapturing: () => !!current.current,
    element: Capture ? (
      <Capture
        cancel={cancel}
        accept={(recording) => {
          if (!live.current || blocked.current || current.current !== capture)
            return false;
          try {
            store.add([recording.file], recording);
            cancel();
            return true;
          } catch (error) {
            report(
              error instanceof Error
                ? error.message
                : "Could not attach voice note.",
            );
            return false;
          }
        }}
      />
    ) : null,
  };
}
