import {
  compileRequest,
  type MarkdownCompileRequest,
} from "./message-markdown-compile";

self.onmessage = (event: MessageEvent<MarkdownCompileRequest[]>) => {
  self.postMessage(event.data.map(compileRequest));
};
