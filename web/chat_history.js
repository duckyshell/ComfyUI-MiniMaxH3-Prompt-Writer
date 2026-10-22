// Conversation history for the embedded llama.cpp chat.
//
// The live chat keeps OpenAI-shaped messages in memory. Image and video parts
// hold multi-megabyte data URLs, so this module persists a text-only copy per
// conversation and reduces attachments to a count. The browser storage quota
// therefore never sees the media payload.

export const CHAT_HISTORY_STORAGE_KEY = "h3ps-chat-history-v1";
export const CHAT_HISTORY_LIMIT = 30;
const MAX_MESSAGES_PER_CONVERSATION = 200;
const MAX_TITLE_CHARS = 60;

function normalizeText(value) {
  return typeof value === "string" ? value : "";
}

function normalizeMessage(message) {
  const role = message?.role === "assistant"
    ? "assistant"
    : message?.role === "user" ? "user" : null;
  if (!role) return null;
  const content = message?.content;
  let text = "";
  let media = 0;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const chunks = [];
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string" && part.text) {
        chunks.push(part.text);
      } else if (part?.type === "image_url" || part?.type === "video_url") {
        media += 1;
      }
    }
    text = chunks.join("\n");
  }
  return { role, text, media };
}

export function sanitizeConversationMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map(normalizeMessage)
    .filter((message) => message && (message.text || message.media))
    .slice(-MAX_MESSAGES_PER_CONVERSATION);
}

export function conversationTitle(messages, fallback = "") {
  const first = messages.find(
    (message) => message?.role === "user" && normalizeText(message.text).trim(),
  );
  if (!first) return fallback;
  const text = first.text.replace(/\s+/g, " ").trim();
  return text.length > MAX_TITLE_CHARS
    ? `${text.slice(0, MAX_TITLE_CHARS - 1)}…`
    : text;
}

// Storage holds the normalized shape ({role, text, media}), while live
// messages use OpenAI content. Accept both so a save round-trips.
function normalizeStoredMessage(message) {
  const live = normalizeMessage(message);
  if (live && (live.text || live.media)) return live;
  const role = message?.role === "assistant"
    ? "assistant"
    : message?.role === "user" ? "user" : null;
  if (!role) return null;
  const text = normalizeText(message.text);
  const media = Math.max(0, Math.trunc(Number(message.media) || 0));
  if (!text && !media) return null;
  return { role, text, media };
}

function normalizeStoredEntry(entry) {
  if (!entry || typeof entry.id !== "string" || !entry.id) return null;
  if (!Array.isArray(entry.messages)) return null;
  const messages = entry.messages
    .map(normalizeStoredMessage)
    .filter(Boolean);
  if (!messages.length) return null;
  const createdAt = Number(entry.createdAt);
  const updatedAt = Number(entry.updatedAt);
  return {
    id: entry.id,
    title: typeof entry.title === "string" && entry.title.trim()
      ? entry.title.trim()
      : conversationTitle(messages, ""),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    messages,
  };
}

function writeHistory(storage, entries) {
  try {
    storage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch (error) {
    console.warn(`[H3 Writer chat] history write failed: ${error?.message || error}`);
    return false;
  }
}

export function loadChatHistory(storage) {
  if (!storage?.getItem) return [];
  let parsed;
  try {
    const raw = storage.getItem(CHAT_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[H3 Writer chat] history load failed: ${error?.message || error}`);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries = parsed
    .map(normalizeStoredEntry)
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return entries.slice(0, CHAT_HISTORY_LIMIT);
}

// Keeps the newest conversation first. If the quota rejects the full list,
// drops the oldest conversation and retries before giving up.
export function saveChatConversation(storage, conversation, limit = CHAT_HISTORY_LIMIT) {
  if (!storage?.getItem || !storage?.setItem) return [];
  const normalized = normalizeStoredEntry(conversation);
  if (!normalized) return loadChatHistory(storage);
  const rest = loadChatHistory(storage).filter((entry) => entry.id !== normalized.id);
  let entries = [normalized, ...rest].slice(0, Math.max(1, limit));
  while (entries.length > 1) {
    if (writeHistory(storage, entries)) return entries;
    entries = entries.slice(0, -1);
    console.warn(
      `[H3 Writer chat] history quota exceeded; dropped the oldest conversation, ` +
      `keeping=${entries.length}`,
    );
  }
  return writeHistory(storage, entries) ? entries : loadChatHistory(storage);
}

export function deleteChatConversation(storage, id) {
  if (!storage?.getItem || !storage?.setItem) return [];
  const entries = loadChatHistory(storage).filter((entry) => entry.id !== id);
  return writeHistory(storage, entries) ? entries : loadChatHistory(storage);
}
