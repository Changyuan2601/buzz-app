/** A new chat's starting name: its first message, on one line, at most 80
 * characters. Automatic naming relies on recognizing this exact name. */
export function startingChatTitle(text: string): string {
  return [...text.trim().replace(/\s+/g, " ")].slice(0, 80).join("");
}
