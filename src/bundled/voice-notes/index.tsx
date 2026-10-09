import { MicrophoneIcon } from "../../shared/design-system/icons";
import type { PluginModule } from "../../plugins/api";
import { VoiceCapture } from "./VoiceCapture";
import { VoiceNoteCard } from "./VoiceNoteCard";
import { isVoiceNoteAttachment } from "./audio";
import styles from "./VoiceNotes.module.css";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerTool({
    id: "recorder",
    title: "Voice Notes",
    order: 10,
    component: ({ session, disabled, capture, focus }) =>
      session.attachments && capture ? (
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Record voice note"
          title="Record voice note"
          disabled={disabled}
          onClick={() =>
            capture(({ accept, cancel }) => (
              <VoiceCapture
                accept={(recording) => {
                  const accepted = accept(recording);
                  if (accepted) focus();
                  return accepted;
                }}
                cancel={() => {
                  cancel();
                  focus();
                }}
              />
            ))
          }
        >
          <MicrophoneIcon size={18} aria-hidden="true" />
        </button>
      ) : null,
  });
  ctx.conversation.registerAttachment({
    id: "player",
    title: "Voice note",
    matches: (attachment) =>
      attachment.voiceNote === true ||
      isVoiceNoteAttachment({
        m: attachment.mime ?? "",
        filename: attachment.name ?? "",
      }),
    component: ({ attachment, source, onRemove }) => (
      <VoiceNoteCard
        source={source}
        {...(attachment.duration === undefined
          ? {}
          : { duration: attachment.duration })}
        {...(attachment.waveform ? { waveform: attachment.waveform } : {})}
        {...(onRemove ? { onRemove } : {})}
      />
    ),
  });
};
