const CHAT_BUCKET = "chat-files";

async function uploadChatFile(file, conversationId) {
  if (!file) return null;
  const maxBytes = 20 * 1024 * 1024;
  if (file.size > maxBytes) throw new Error("الحد الأقصى لحجم الملف 20 ميجابايت");
  const safeName = file.name.replace(/[^\w.\-()]/g, "_").slice(-100) || "attachment";
  const path = `${conversationId}/${currentUser.id}/${crypto.randomUUID()}-${safeName}`;
  const { error } = await db.storage.from(CHAT_BUCKET).upload(path, file, {
    cacheControl: "3600", upsert: false, contentType: file.type || "application/octet-stream"
  });
  if (error) throw error;
  // لا نستخدم روابط عامة. يتم توليد رابط مؤقت بعد التحقق من صلاحية العضو.
  return { path, name: file.name, type: file.type || "application/octet-stream", size: file.size };
}
async function createAttachmentUrl(path) {
  const { data, error } = await db.storage.from(CHAT_BUCKET).createSignedUrl(path, 60 * 60);
  if (error) throw error;
  return data.signedUrl;
}