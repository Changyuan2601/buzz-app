import { expect, it } from "vitest";
import {
  assistantDisplayContent,
  citationDisplaySeams,
} from "./assistant-citations";

const citation = `<oai-mem-citation>
<citation_entries>
MEMORY.md:34-34|note=[Verified guidance]
</citation_entries>
<rollout_ids>
first
</rollout_ids>
</oai-mem-citation>`;

it("removes complete envelopes anywhere in prose and keeps surrounding bytes", () => {
  const image = "![STATUS\\_MENU.png](<https://example.test/image.png>)";
  expect(
    assistantDisplayContent(`Reply.\n\n${citation}\n${image}`).content,
  ).toBe(`Reply.\n\n${image}`);
  expect(
    assistantDisplayContent(`${citation}\nAnswer\n${citation}`).content,
  ).toBe("Answer\n");
  for (const block of [
    citation.replaceAll("\n", "\r\n"),
    `  ${citation}`,
    "<oai-mem-citation> <citation_entries>other</citation_entries> </oai-mem-citation>",
  ]) {
    expect(assistantDisplayContent(`${block}\nAnswer`).content).toBe("Answer");
  }
});

it.each([
  `\`${citation}\``,
  `\`\`${citation}\`\``,
  `\`\`\`xml\n${citation}\n\`\`\``,
  `~~~xml\n${citation}\n~~~`,
  `\`\`\`\`\n\`\`\`\n${citation}\n\`\`\`\``,
  `\`\`\`xml\n${citation}`,
  `\`example\n${citation}`,
  citation
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n"),
  citation
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n"),
  `\\${citation}`,
  "The tag is <oai-mem-citation>.",
  "<oai-mem-citation>Useful prose</oai-mem-citation>",
  citation.replace("</oai-mem-citation>", ""),
  citation.replaceAll("citation_entries", "example"),
  "<details>Useful prose</details>",
  `Explain ${citation} please`,
])("preserves literal or unrecognized content: %s", (source) => {
  expect(assistantDisplayContent(source).content).toBe(source);
});

it("resumes after code closes and respects escaped backticks", () => {
  const example = `~~~xml\n${citation}\n~~~\n`;
  expect(assistantDisplayContent(`${example}${citation}\nAnswer`).content).toBe(
    `${example}Answer`,
  );
  expect(
    assistantDisplayContent(`\\\`literal\n${citation}\nAnswer`).content,
  ).toBe("\\`literal\nAnswer");
});

it("keeps mention boundaries aligned after removed metadata", () => {
  const prefix = `${citation}\n`;
  const projected = assistantDisplayContent(`${prefix}@Mic Smith`);
  expect(citationDisplaySeams([prefix.length + 4], projected.removed)).toEqual([
    4,
  ]);
});

it("handles a large sequence of malformed openers without rescanning suffixes", () => {
  const source = "<oai-mem-citation>\n".repeat(100_000);
  expect(assistantDisplayContent(source).content).toBe(source);
});
