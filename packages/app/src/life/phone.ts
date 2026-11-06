import { isSelfMessageEvent } from "../events/helpers";
import type {
  Conversation,
  MessageReceivedEvent
} from "../events/schemas";
import type { SessionEventRecord } from "../session/schemas";
import type { SessionStore } from "../session/store";
import type { LifeState } from "./state";
import { conversationIdFromPlace, placeIdForConversation } from "./places";

export interface PhonePlace {
  place: string;
  conversation: Conversation;
  unread: number;
  called: boolean;
  lastMessageAt?: string;
}

export interface PhoneView {
  places: PhonePlace[];
  anyoneCalling: boolean;
}

export function isMessageRecord(
  record: SessionEventRecord
): record is SessionEventRecord & { event: MessageReceivedEvent } {
  return record.event.type === "MessageReceived";
}

/** Everything after this place's read position that the bot did not send. */
export function selectUnreadRecords(
  records: readonly SessionEventRecord[],
  lastRead: LifeState["lastRead"][string] | undefined
): SessionEventRecord[] {
  const messages = records.filter(isMessageRecord);
  if (!lastRead) {
    return messages.filter((record) => !isSelfMessageEvent(record.event));
  }
  const index = messages.findIndex(
    (record) => record.event.id === lastRead.eventId
  );
  const after =
    index >= 0
      ? messages.slice(index + 1)
      : messages.filter((record) => record.receivedAt > lastRead.at);
  return after.filter((record) => !isSelfMessageEvent(record.event));
}

/** Someone addressed the bot directly: an @, a reply to it, or a private chat. */
export function isCallingBot(
  record: SessionEventRecord,
  conversationRecords: readonly SessionEventRecord[]
): boolean {
  const event = record.event;
  if (event.type !== "MessageReceived" || isSelfMessageEvent(event)) {
    return false;
  }
  if (event.conversation.kind === "private" || event.message.mentionsBot) {
    return true;
  }
  const replyTo = event.message.replyToMessageId;
  if (!replyTo) {
    return false;
  }
  return conversationRecords.some(
    (candidate) =>
      candidate.event.type === "MessageReceived" &&
      candidate.event.message.id === replyTo &&
      isSelfMessageEvent(candidate.event)
  );
}

export function readPhone(input: {
  sessionStore: SessionStore;
  state: LifeState;
  allowedGroupIds?: ReadonlySet<string> | undefined;
}): PhoneView {
  const places: PhonePlace[] = [];
  for (const conversation of input.sessionStore.listConversations()) {
    if (
      conversation.kind === "group" &&
      input.allowedGroupIds &&
      !input.allowedGroupIds.has(conversation.id)
    ) {
      continue;
    }
    const place = placeIdForConversation(conversation);
    const records = input.sessionStore.getEvents(conversation);
    const unread = selectUnreadRecords(records, input.state.lastRead[place]);
    const last = records.filter(isMessageRecord).at(-1);
    places.push({
      place,
      conversation,
      unread: unread.length,
      called: unread.some((record) => isCallingBot(record, records)),
      ...(last ? { lastMessageAt: last.receivedAt } : {})
    });
  }
  // The session store only holds recent history, but a chat it has read stays a
  // chat it knows, however long that chat has been quiet.
  for (const [place, lastRead] of Object.entries(input.state.lastRead)) {
    const conversation = conversationIdFromPlace(place);
    if (
      !conversation ||
      places.some((entry) => entry.place === place) ||
      (conversation.kind === "group" &&
        input.allowedGroupIds &&
        !input.allowedGroupIds.has(conversation.id))
    ) {
      continue;
    }
    places.push({
      place,
      conversation,
      unread: 0,
      called: false,
      lastMessageAt: lastRead.at
    });
  }
  places.sort((left, right) =>
    (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? "")
  );
  return {
    places,
    anyoneCalling: places.some((place) => place.called)
  };
}
