import type { Root } from "mdast";
import type { PreparedMarkdown } from "./markdown-preparation";

type Result =
  | { prepared: PreparedMarkdown; tree?: Root | undefined }
  | undefined;
const maxEntries = 1000;
// Results wait here for their row's first render. Prepared values are
// immutable and reusable; a tree is taken once because remark plugins mutate it.
const preparedByContent = new Map<string, PreparedMarkdown>();
const treesBySource = new Map<string, Root>();
const pending = new Map<number, (results: Result[] | undefined) => void>();
let nextRequest = 0;
// undefined: not started yet; null: unavailable, so rows prepare on render.
let worker: Worker | null | undefined;

function bounded<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= maxEntries) break;
    map.delete(oldest);
  }
}

function preparationWorker() {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === "undefined") return worker;
  try {
    worker = new Worker(
      new URL("./markdown-preparation.worker.ts", import.meta.url),
      { type: "module" },
    );
  } catch {
    return worker;
  }
  worker.onmessage = (
    message: MessageEvent<{ id: number; results: Result[] }>,
  ) => {
    pending.get(message.data.id)?.(message.data.results);
    pending.delete(message.data.id);
  };
  worker.onerror = () => {
    worker?.terminate();
    worker = null;
    for (const settle of pending.values()) settle(undefined);
    pending.clear();
  };
  return worker;
}

/** Prepare and parse message bodies off the main thread before their rows
 * render. Resolves without work when no worker is available. */
export async function prepareMessageContents(contents: readonly string[]) {
  const target = preparationWorker();
  const missing = [...new Set(contents)].filter(
    (content) => !preparedByContent.has(content),
  );
  if (!target || !missing.length) return;
  const id = nextRequest++;
  const results = await new Promise<Result[] | undefined>((resolve) => {
    pending.set(id, resolve);
    target.postMessage({ id, contents: missing });
  });
  results?.forEach((result, index) => {
    const content = missing[index];
    if (!result || content === undefined) return;
    const { prepared, tree } = result;
    bounded(
      preparedByContent,
      content,
      Object.freeze(
        prepared.kind === "plain"
          ? prepared
          : {
              ...prepared,
              literalRanges: Object.freeze(
                prepared.literalRanges.map((range) => Object.freeze(range)),
              ),
              spoilerDelimiters: Object.freeze(prepared.spoilerDelimiters),
            },
      ),
    );
    if (prepared.kind === "markdown" && tree)
      bounded(treesBySource, prepared.content, tree);
  });
}

export function preparedMarkdown(content: string) {
  return preparedByContent.get(content);
}

/** The worker's tree for this exact parser input, at most once. */
export function takeMarkdownTree(source: string) {
  const tree = treesBySource.get(source);
  treesBySource.delete(source);
  return tree;
}
