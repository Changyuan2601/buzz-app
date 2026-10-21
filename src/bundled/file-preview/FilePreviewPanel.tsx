import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PanelProps } from "../../features/panels/service";
import { FileAttachment } from "../../features/messages/FileAttachment";
import {
  safeLinkUrl,
  scanMarkdown,
} from "../../features/relay/message-content";
import { Button } from "../../shared/design-system/ui/Button";
import messageStyles from "../../features/messages/Messages.module.css";
import styles from "./FilePreview.module.css";
import { loadPreview, parsePreviewTarget } from "./preview";

type PreviewState =
  | { kind: "loading" }
  | { kind: "ready"; text: string }
  | { kind: "error"; message: string };

export function FilePreviewPanel({ target, context }: PanelProps) {
  const [attempt, retry] = useState(0);
  const file = parsePreviewTarget(target);
  return file ? (
    <Preview
      key={`${target}:${attempt}`}
      file={file}
      open={context?.open ?? (() => false)}
      retry={() => retry(attempt + 1)}
    />
  ) : (
    <p role="alert">This file cannot be previewed.</p>
  );
}

function Preview({
  file,
  open,
  retry,
}: {
  file: NonNullable<ReturnType<typeof parsePreviewTarget>>;
  open(target: string): boolean;
  retry(): void;
}) {
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    void loadPreview(
      file.source,
      AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    ).then(
      (text) => {
        if (!controller.signal.aborted) setState({ kind: "ready", text });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "The file could not be loaded. Try again.",
          });
      },
    );
    return () => controller.abort();
  }, [file.source]);
  return (
    <section
      className={styles.content}
      aria-label={`Preview: ${file.attachment.name ?? "file"}`}
    >
      <FileAttachment
        variant="summary"
        attachment={file.attachment}
        source={file.source}
        onOpenLink={open}
        typeLabel={file.format === "markdown" ? "Markdown" : "Plain text"}
      />
      {state.kind === "loading" ? (
        <p role="status">Loading preview…</p>
      ) : state.kind === "error" ? (
        <div role="alert">
          <p>{state.message}</p>
          <Button size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : !state.text ? (
        <p role="status">This file is empty.</p>
      ) : file.format === "markdown" && !scanMarkdown(state.text).tooDeep ? (
        <div className={messageStyles.text}>
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            urlTransform={(url) => safeLinkUrl(url) ?? ""}
            components={{
              a: ({ href, children }) =>
                href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ) : (
                  children
                ),
              img: ({ alt }) => <span>{alt || "Image"} (image omitted)</span>,
            }}
          >
            {state.text}
          </Markdown>
        </div>
      ) : (
        <pre className={styles.text}>{state.text}</pre>
      )}
    </section>
  );
}
