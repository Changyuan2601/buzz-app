import type { PluginModule } from "../../plugins/api";
import type { AttachmentRendererProps } from "../../features/conversation/contracts";
import { FileAttachment } from "../../features/messages/FileAttachment";
import { FilePreviewPanel } from "./FilePreviewPanel";
import {
  parsePreviewTarget,
  previewFormat,
  previewSource,
  previewTarget,
} from "./preview";

export const inject = ["conversation", "panels"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.panels.register({
    id: "preview",
    title: "File preview",
    matches: (target) => !!parsePreviewTarget(target),
    component: FilePreviewPanel,
  });
  ctx.conversation.registerAttachment({
    id: "file",
    title: "File preview",
    matches: (attachment) => !!previewFormat(attachment),
    component: PreviewAttachment,
  });
};

function PreviewAttachment({
  attachment,
  source,
  placement,
  canOpen,
  open,
}: AttachmentRendererProps) {
  const target = previewTarget(attachment, source);
  const preview =
    placement === "message" && previewSource(source) && canOpen(target);
  return (
    <FileAttachment
      attachment={attachment}
      source={source}
      onOpenLink={open}
      {...(preview ? { onPreview: () => open(target) } : {})}
    />
  );
}
