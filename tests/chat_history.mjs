import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_HISTORY_LIMIT,
  CHAT_HISTORY_STORAGE_KEY,
  conversationTitle,
  deleteChatConversation,
  loadChatHistory,
  sanitizeConversationMessages,
  saveChatConversation,
} from "../web/chat_history.js";

function memoryStorage(maxChars = Infinity) {
  const map = new Map();
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      const text = String(value);
      if (text.length > maxChars) throw new Error("QuotaExceededError");
      map.set(key, text);
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

function conversation(id, text, updatedAt = 1) {
  return {
    id,
    createdAt: updatedAt,
    updatedAt,
    messages: [{ role: "user", text }],
  };
}

test("history snapshots keep text and replace media parts with a count", () => {
  const live = [
    { role: "system", content: "system prompts are not persisted" },
    {
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
        { type: "video_url", video_url: { url: "data:video/mp4;base64,BBBB" } },
      ],
    },
    { role: "assistant", content: "A red car." },
  ];
  assert.deepEqual(sanitizeConversationMessages(live), [
    { role: "user", text: "what is this", media: 2 },
    { role: "assistant", text: "A red car.", media: 0 },
  ]);
  assert.deepEqual(sanitizeConversationMessages(null), []);
});

test("history titles come from the first user message", () => {
  assert.equal(conversationTitle([{ role: "user", text: "  hello \n  world  " }], "Untitled"), "hello world");
  assert.equal(conversationTitle([{ role: "assistant", text: "x" }], "Untitled"), "Untitled");
  assert.equal(conversationTitle([{ role: "user", text: "   " }], "Untitled"), "Untitled");
  assert.equal(conversationTitle([], "Untitled"), "Untitled");
  const long = conversationTitle([{ role: "user", text: "x".repeat(100) }]);
  assert.equal(long.length, 60);
  assert.ok(long.endsWith("…"));
});

test("saving and loading conversations preserves order and never stores media", () => {
  const storage = memoryStorage();
  saveChatConversation(storage, conversation("a", "first", 1));
  saveChatConversation(storage, conversation("b", "second", 2));
  assert.deepEqual(loadChatHistory(storage).map((entry) => entry.id), ["b", "a"]);
  assert.equal(loadChatHistory(storage)[0].title, "second");

  saveChatConversation(storage, {
    id: "a",
    createdAt: 1,
    updatedAt: 5,
    messages: [
      { role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,ZZZZ" } },
      ] },
      { role: "assistant", content: "seen" },
    ],
  });
  const updated = loadChatHistory(storage);
  assert.deepEqual(updated.map((entry) => entry.id), ["a", "b"]);
  assert.equal(updated[0].createdAt, 1);
  assert.equal(updated[0].updatedAt, 5);
  assert.equal(updated[0].messages[0].media, 1);
  const raw = storage.getItem(CHAT_HISTORY_STORAGE_KEY);
  assert.ok(!raw.includes("data:image"), "media data URLs must never be persisted");
  assert.ok(!raw.includes("base64"), "media payloads must never be persisted");
});

test("corrupt or unsupported history payloads are ignored", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadChatHistory(storage), []);
  storage.setItem(CHAT_HISTORY_STORAGE_KEY, "{not json");
  assert.deepEqual(loadChatHistory(storage), []);
  storage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify({ conversations: [] }));
  assert.deepEqual(loadChatHistory(storage), []);
  storage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify([
    { id: "missing-messages" },
    { id: 7, messages: [{ role: "user", text: "hi" }] },
    { id: "empty", messages: [] },
    { id: "blank", messages: [{ role: "user", text: "" }] },
    { id: "ok", messages: [{ role: "user", text: "hi" }] },
  ]));
  assert.deepEqual(loadChatHistory(storage).map((entry) => entry.id), ["ok"]);
  assert.deepEqual(loadChatHistory(undefined), []);
});

test("deleting removes only the requested conversation", () => {
  const storage = memoryStorage();
  saveChatConversation(storage, conversation("a", "first", 1));
  saveChatConversation(storage, conversation("b", "second", 2));
  assert.deepEqual(deleteChatConversation(storage, "a").map((entry) => entry.id), ["b"]);
  assert.deepEqual(deleteChatConversation(storage, "missing").map((entry) => entry.id), ["b"]);
  assert.deepEqual(loadChatHistory(storage).map((entry) => entry.id), ["b"]);
});

test("history keeps at most the configured number of newest conversations", () => {
  const storage = memoryStorage();
  for (let index = 0; index < CHAT_HISTORY_LIMIT + 3; index += 1) {
    saveChatConversation(storage, conversation(`c${index}`, `message ${index}`, index + 1));
  }
  const entries = loadChatHistory(storage);
  assert.equal(entries.length, CHAT_HISTORY_LIMIT);
  assert.equal(entries[0].id, `c${CHAT_HISTORY_LIMIT + 2}`);
  assert.ok(!entries.some((entry) => entry.id === "c0"));
});

test("a storage quota failure drops the oldest conversation", () => {
  const storage = memoryStorage(1000);
  saveChatConversation(storage, conversation("old", "o".repeat(300), 1));
  saveChatConversation(storage, conversation("mid", "m".repeat(300), 2));
  const saved = saveChatConversation(storage, conversation("new", "n".repeat(300), 3));
  assert.equal(saved[0].id, "new");
  assert.ok(saved.length < 3, "the oldest conversation must be dropped to fit");
  assert.deepEqual(
    loadChatHistory(storage).map((entry) => entry.id),
    saved.map((entry) => entry.id),
  );
});
