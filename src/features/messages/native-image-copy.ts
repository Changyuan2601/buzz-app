import { invoke } from "@tauri-apps/api/core";

/** The host validates the source again and owns authenticated bytes and clipboard. */
export async function copyNativeImage(source: string): Promise<void> {
  await invoke("media_copy_image", { source });
}
