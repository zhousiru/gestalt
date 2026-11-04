import type { Conversation } from "../events/schemas";

export const WEB_PLACE = "web";
export const DREAM_PLACE = "dream";

export function placeIdForConversation(conversation: Conversation): string {
  return `${conversation.kind}-${encodeURIComponent(conversation.id)}`;
}

export function conversationIdFromPlace(
  placeId: string
): Pick<Conversation, "kind" | "id"> | undefined {
  const match = placeId.match(/^(group|private)-(.+)$/);
  if (!match) {
    return undefined;
  }
  const [, kind, id] = match;
  if ((kind !== "group" && kind !== "private") || !id) {
    return undefined;
  }
  try {
    return { kind, id: decodeURIComponent(id) };
  } catch {
    return undefined;
  }
}

export function isValidPlaceSegment(placeId: string): boolean {
  return /^[A-Za-z0-9._%-]+$/.test(placeId) && !placeId.startsWith(".");
}
