#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { entry, exportSession } from "./session-viewer.mjs";

// Tool results are a string or a list of text/image content blocks.
const resultText = (content) =>
  Array.isArray(content) &&
  content.every((block) => typeof block?.text === "string")
    ? content.map((block) => block.text).join("\n")
    : content;
// Buzz events carry `Content: <message>` followed by a `Tags:` line.
const buzzRequest = (value) =>
  value.match(/^Content: ([\s\S]*?)\nTags: /m)?.[1];
// Name a tool call's target; shell commands already show as the input.
const target = (input) =>
  ["file_path", "description", "pattern", "url", "query"]
    .map((key) => input?.[key])
    .find((value) => typeof value === "string") ?? "";

export function buildClaude(records) {
  const messages = records.filter((record) => record?.message != null);
  const results = new Map(
    messages.flatMap((record) =>
      Array.isArray(record.message.content)
        ? record.message.content
            .filter((block) => block?.type === "tool_result")
            .map((block) => [block.tool_use_id, block])
        : [],
    ),
  );
  const entries = [];
  let model;
  for (const { timestamp, type, isMeta, message } of messages) {
    if (message.model && message.model !== model) {
      model = message.model;
      entries.push(entry.model(timestamp, model));
    }
    const blocks = Array.isArray(message.content)
      ? message.content
      : [{ type: "text", text: message.content }];
    if (type === "user") {
      const body = blocks
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("\n\n")
        .trim();
      if (body)
        entries.push(
          isMeta
            ? entry.instructions(timestamp, "meta", body)
            : entry.user(timestamp, body, buzzRequest(body)),
        );
      for (const block of blocks)
        if (block?.type !== "text" && block?.type !== "tool_result")
          entries.push(entry.other(timestamp, block?.type ?? "content", block));
      continue;
    }
    for (const block of blocks) {
      if (block?.type === "text" && block.text?.trim())
        entries.push(entry.assistant(timestamp, block.text.trim()));
      else if (block?.type === "thinking") {
        if (block.thinking?.trim())
          entries.push(entry.thinking(timestamp, block.thinking.trim()));
      } else if (
        block?.type === "tool_use" &&
        /(^|__)buzz__send$/.test(block.name) &&
        typeof block.input?.text === "string"
      ) {
        entries.push(entry.sent(timestamp, block.input.text));
      } else if (block?.type === "tool_use") {
        const result = results.get(block.id);
        entries.push(
          entry.tool(timestamp, {
            name: block.name,
            detail: target(block.input),
            input: block.input?.command ?? block.input,
            result: result && resultText(result.content),
            error: result?.is_error === true,
          }),
        );
      } else if (block?.type !== "text")
        entries.push(entry.other(timestamp, block?.type ?? "content", block));
    }
  }
  const first = messages[0] ?? {};
  const unique = (key) => [
    ...new Set(messages.map((record) => record[key]).filter(Boolean)),
  ];
  return {
    title: "Claude Code session",
    info: [
      `Session: ${first.sessionId}`,
      `Working directory: ${unique("cwd").join(", ")}`,
      `Started: ${first.timestamp}`,
    ],
    entries,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  exportSession(buildClaude);
