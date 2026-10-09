/** Host-owned media boundary. Audio bytes never become event content. */
export const MAX_VOICE_SECONDS = 300;
export const MAX_VOICE_BYTES = 44 + MAX_VOICE_SECONDS * 24000 * 2;
export type VoiceRecording = Readonly<{
  file: File;
  duration: number;
  waveform: readonly number[];
}>;
export function validateRecording(value: VoiceRecording) {
  if (
    !(value.file instanceof Blob) ||
    value.file.type !== "audio/wav" ||
    value.file.size <= 44 ||
    value.file.size > MAX_VOICE_BYTES ||
    !Number.isFinite(value.duration) ||
    value.duration <= 0 ||
    value.duration > MAX_VOICE_SECONDS + 0.1 ||
    !Array.isArray(value.waveform) ||
    !value.waveform.length ||
    value.waveform.length > 100 ||
    value.waveform.some((n) => !Number.isFinite(n) || n < 0 || n > 1)
  )
    throw new Error("This voice note is invalid or exceeds five minutes.");
}
