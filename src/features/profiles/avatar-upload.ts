import { prepareAttachment } from "../messages/prepare-attachment";
import { mediaUrl } from "../relay/transport";
import { nativeIdentityEnabled } from "../identity/service";
import { nativeMediaUrl } from "../relay/native";
import { connectCommunityTransport } from "../communities/connection";
import { communityDestination } from "../communities/destination";
import { avatarSource } from "../../shared/avatar-source";

/** Shared save policy; display-only inherited artwork may still fail validation. */
export function avatarPictureError(value: string): string | undefined {
  if (
    !value ||
    (value.length <= 2048 && avatarSource(value)?.startsWith("https://"))
  )
    return undefined;
  return "Use an HTTPS image URL without credentials (up to 2,048 characters), or remove the avatar.";
}

export function avatarPreview(
  value: string,
  community?: string,
): string | undefined {
  const source = avatarSource(value);
  if (!source || !community || source.startsWith("data:")) return source;
  return communityMedia(community)(source);
}

/** Relay-hosted media of one community through the host's media adapter. */
export function communityMedia(community: string) {
  const { id, url } = communityDestination(community);
  const proxy = nativeIdentityEnabled()
    ? nativeMediaUrl
    : (target: string) =>
        `/api/relay/${encodeURIComponent(id)}/media?url=${encodeURIComponent(target)}`;
  return (source: string, size?: "small") => mediaUrl(source, proxy, url, size);
}

/** Use the existing host upload/preparation contract, never an agent key in React. */
export async function uploadAvatar(
  file: File,
  community: string,
  signal: AbortSignal,
): Promise<string> {
  if (!/^image\/(png|jpeg|gif|webp|heic|heif)$/.test(file.type))
    throw new Error("Choose a PNG, JPEG, GIF, WebP or HEIC image.");
  if (!file.size || file.size > 50 * 1024 * 1024)
    throw new Error("Choose an image smaller than 50 MiB.");
  const transport = await connectCommunityTransport(
    communityDestination(community).id,
    signal,
  );
  if (!transport.uploadAttachment)
    throw new Error("Image uploads are unavailable on this connection.");
  const prepared = await prepareAttachment(file, signal, true);
  const result = await transport.uploadAttachment(prepared, signal);
  signal.throwIfAborted();
  if (!result.type.startsWith("image/") || !avatarSource(result.url))
    throw new Error("The server did not return an avatar image.");
  return result.url;
}

/** Center painted pixels: emoji font metrics differ between browser engines. */
export function paintEmojiAvatar(
  canvas: HTMLCanvasElement,
  emoji: string,
  color?: string,
) {
  canvas.width = canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("Emoji images are unavailable in this browser.");
  context.font =
    '258px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#000000";
  context.fillText(emoji, 256, 256);
  const pixels = context.getImageData(0, 0, 512, 512);
  let left = 512;
  let right = -1;
  let top = 512;
  let bottom = -1;
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 512; x++) {
      // Ignore the nearly transparent fringe/shadow around Apple emoji artwork.
      if ((pixels.data[(y * 512 + x) * 4 + 3] ?? 0) < 32) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  context.clearRect(0, 0, 512, 512);
  if (right >= left) {
    context.putImageData(
      pixels,
      Math.round(256 - (left + right + 1) / 2),
      Math.round(256 - (top + bottom + 1) / 2),
    );
  }
  if (color) {
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = color;
    context.fillRect(0, 0, 512, 512);
    context.globalCompositeOperation = "source-over";
  }
}

/** Persist ordinary square artwork; Avatar owns human/agent clipping. */
export async function emojiAvatar(emoji: string, color: string): Promise<File> {
  if (!emoji || emoji.length > 64 || !/^#[0-9a-f]{6}$/i.test(color))
    throw new Error("Choose an emoji and a background color.");
  const canvas = document.createElement("canvas");
  paintEmojiAvatar(canvas, emoji, color);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value
          ? resolve(value)
          : reject(new Error("Could not prepare the emoji image.")),
      "image/png",
    ),
  );
  return new File([blob], "avatar.png", { type: "image/png" });
}
