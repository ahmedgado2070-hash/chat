let conversations = [];
let activeConversation = null;
let activeChannel = null;
let selectedFile = null;
let mediaRecorder = null;
let audioChunks = [];
let currentFilter = "all";

function toast(message) {
  document.getElementById("toastText").textContent = message;
  bootstrap.Toast.getOrCreateInstance(document.getElementById("appToast")).show();
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
async function loadConversations() {
  const { data, error } = await db.from("conversation_members")
    .select("conversation_id, role, conversations(id, title, type, created_at)")
    .eq("user_id", currentUser.id);
  if (error) { toast(error.message); return; }
  const ids = (data || []).map(x => x.conversation_id);
  if (!ids.length) { conversations = []; renderConversationList(); return; }
  const { data: members, error: mErr } = await db.from("conversation_members")
    .select("conversation_id,user_id,profiles(display_name)")
    .in("conversation_id", ids);
  if (mErr) console.warn(mErr);
  const counts = {};
  (members || []).forEach(m => counts[m.conversation_id] = (counts[m.conversation_id] || 0) + 1);
  conversations = data.map(x => ({...x.conversations, role:x.role, count:counts[x.conversation_id] || 1}));
  renderConversationList();
}
function renderConversationList() {
  const list = document.getElementById("conversationList");
  const query = (document.getElementById("searchInput").value || "").trim().toLowerCase();
  const shown = conversations.filter(c => (currentFilter === "all" || c.type === currentFilter) && (c.title || (c.type === "direct" ? "محادثة خاصة" : "")).toLowerCase().includes(query));
  list.innerHTML = "";
  if (!shown.length) { list.innerHTML = '<div class="empty-hint py-5">لا توجد محادثات مطابقة.</div>'; return; }
  shown.forEach(c => {
    const btn = document.createElement("button");
    btn.className = "conversation-item" + (activeConversation?.id === c.id ? " active" : "");
    const title = c.title || "محادثة خاصة";
    btn.innerHTML = `<div class="avatar">${escapeHtml(title.slice(0,1))}</div><div class="meta"><strong>${escapeHtml(title)}</strong><small>${c.type === "group" ? `مجموعة · ${c.count} أعضاء` : "محادثة خاصة"}</small></div><i class="bi bi-chevron-left small text-secondary"></i>`;
    btn.addEventListener("click", () => openConversation(c));
    list.appendChild(btn);
  });
}
async function openConversation(conversation) {
  activeConversation = conversation;
  document.getElementById("welcomePanel").classList.add("d-none");
  document.getElementById("activeChat").classList.remove("d-none");
  document.getElementById("chatTitle").textContent = conversation.title || "محادثة خاصة";
  document.getElementById("chatSubtitle").textContent = conversation.type === "group" ? `مجموعة · ${conversation.count} أعضاء` : "محادثة خاصة";
  document.getElementById("chatAvatar").textContent = (conversation.title || "م").slice(0,1);
  document.getElementById("appView").classList.add("chat-open");
  renderConversationList();
  if (activeChannel) await db.removeChannel(activeChannel);
  await loadMessages();
  activeChannel = db.channel(`messages-${conversation.id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${conversation.id}` }, payload => {
      if (payload.new.sender_id !== currentUser.id) {
        appendMessage(payload.new);
        notifyIncoming(payload.new);
      }
    }).subscribe();
}
async function loadMessages() {
  const area = document.getElementById("messageArea");
  area.innerHTML = '<div class="empty-hint">جارٍ تحميل الرسائل...</div>';
  const { data, error } = await db.from("messages").select("*").eq("conversation_id", activeConversation.id).order("created_at", { ascending: true }).limit(300);
  if (error) { area.innerHTML = `<div class="empty-hint">${escapeHtml(error.message)}</div>`; return; }
  area.innerHTML = "";
  if (!data?.length) area.innerHTML = '<div class="empty-hint">لا توجد رسائل بعد. ابدأ المحادثة الآن.</div>';
  for (const msg of data || []) await appendMessage(msg);
  area.scrollTop = area.scrollHeight;
}
async function appendMessage(msg) {
  const area = document.getElementById("messageArea");
  const empty = area.querySelector(".empty-hint"); if (empty) empty.remove();
  const mine = msg.sender_id === currentUser.id;
  const row = document.createElement("div");
  row.className = "message-row" + (mine ? " mine" : "");
  let attachment = "";
  if (msg.attachment_path) {
    try {
      const url = await createAttachmentUrl(msg.attachment_path);
      if (msg.attachment_type?.startsWith("image/")) attachment = `<a class="message-file" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="صورة مرفقة"></a>`;
      else if (msg.attachment_type?.startsWith("audio/")) attachment = `<audio controls src="${url}" class="message-file"></audio>`;
      else attachment = `<a class="message-file" href="${url}" target="_blank" rel="noopener"><i class="bi bi-file-earmark-arrow-down"></i> ${escapeHtml(msg.attachment_name || "تحميل الملف")}</a>`;
    } catch (e) { attachment = '<small>تعذر تحميل المرفق</small>'; }
  }
  const time = new Date(msg.created_at).toLocaleTimeString("ar-EG", {hour:"2-digit",minute:"2-digit"});
  row.innerHTML = `<div class="bubble">${msg.body ? escapeHtml(msg.body).replace(/\n/g,"<br>") : ""}${attachment}</div><div class="message-meta">${mine ? "أنت · " : ""}${time}</div>`;
  area.appendChild(row); area.scrollTop = area.scrollHeight;
}
async function sendMessage(body, file = null) {
  if (!activeConversation) return;
  let uploaded = null;
  if (file) uploaded = await uploadChatFile(file, activeConversation.id);
  const payload = { conversation_id: activeConversation.id, sender_id: currentUser.id, body: body || null };
  if (uploaded) Object.assign(payload, { attachment_path: uploaded.path, attachment_name: uploaded.name, attachment_type: uploaded.type, attachment_size: uploaded.size });
  const { error } = await db.from("messages").insert(payload);
  if (error) throw error;
  if (body || uploaded) {
    // عرض فوري للمرسل؛ قناة Realtime لا تعرض رسائله هنا لتجنب التكرار.
    const { data } = await db.from("messages").select("*").eq("conversation_id", activeConversation.id).eq("sender_id", currentUser.id).order("created_at", {ascending:false}).limit(1);
    if (data?.[0]) await appendMessage(data[0]);
  }
}
async function createDirectConversation(email) {
  const { data: target, error: userError } = await db.from("profiles").select("id,display_name").eq("email", email.toLowerCase()).maybeSingle();
  if (userError) throw userError;
  if (!target) throw new Error("لم يتم العثور على مستخدم بهذا البريد الإلكتروني");
  if (target.id === currentUser.id) throw new Error("لا يمكنك بدء محادثة مع نفسك");
  const { data: existing, error: eErr } = await db.rpc("find_direct_conversation", { other_user: target.id });
  if (eErr) throw eErr;
  let convId = existing;
  if (!convId) {
    const { data: conv, error } = await db.from("conversations").insert({ type:"direct", created_by:currentUser.id }).select().single();
    if (error) throw error;
    const { error: mErr } = await db.from("conversation_members").insert([
      {conversation_id:conv.id,user_id:currentUser.id,role:"member"},
      {conversation_id:conv.id,user_id:target.id,role:"member"}
    ]);
    if (mErr) throw mErr;
    convId = conv.id;
  }
  await loadConversations();
  const conv = conversations.find(c => c.id === convId);
  if (conv) await openConversation(conv);
}
async function createGroup(name, emails) {
  const { data: conv, error } = await db.from("conversations").insert({type:"group",title:name,created_by:currentUser.id}).select().single();
  if (error) throw error;
  const ids = [currentUser.id];
  for (const email of emails) {
    const { data, error: lookupError } = await db.from("profiles").select("id").eq("email",email).maybeSingle();
    if (lookupError) throw lookupError;
    if (data && !ids.includes(data.id)) ids.push(data.id);
  }
  const rows = ids.map(id => ({conversation_id:conv.id,user_id:id,role:id===currentUser.id?"admin":"member"}));
  const { error: mErr } = await db.from("conversation_members").insert(rows);
  if (mErr) throw mErr;
  await loadConversations();
  const created = conversations.find(c => c.id === conv.id);
  if (created) await openConversation(created);
}
async function showMembers() {
  if (!activeConversation || activeConversation.type !== "group") { toast("هذه محادثة خاصة بين شخصين"); return; }
  const { data, error } = await db.from("conversation_members").select("role,profiles(display_name,email)").eq("conversation_id",activeConversation.id);
  if (error) { toast(error.message); return; }
  const target = document.getElementById("membersList"); target.innerHTML = "";
  (data || []).forEach(m => {
    const line = document.createElement("div"); line.className = "member-line";
    line.innerHTML = `<div class="avatar">${escapeHtml((m.profiles?.display_name || "?").slice(0,1))}</div><div><strong>${escapeHtml(m.profiles?.display_name || "مستخدم")}</strong><div class="small text-secondary">${escapeHtml(m.profiles?.email || "")} · ${m.role === "admin" ? "مدير المجموعة" : "عضو"}</div></div>`;
    target.appendChild(line);
  });
  bootstrap.Modal.getOrCreateInstance(document.getElementById("membersModal")).show();
}
async function searchMessages(term) {
  if (!term.trim() || !activeConversation) return;
  const { data, error } = await db.from("messages").select("*").eq("conversation_id",activeConversation.id).ilike("body",`%${term.trim()}%`).order("created_at",{ascending:false}).limit(100);
  if (error) { toast(error.message); return; }
  const area = document.getElementById("messageArea"); area.innerHTML = "";
  if (!data?.length) { area.innerHTML = '<div class="empty-hint">لا توجد نتائج.</div>'; return; }
  for (const msg of data.reverse()) await appendMessage(msg);
}
function notifyIncoming(msg) {
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    new Notification("رسالة جديدة في ChatHub", { body: msg.body || "أرسل مرفقاً", icon: "assets/icon.png" });
  } else if (document.hidden) toast("وصلتك رسالة جديدة");
}
document.getElementById("messageForm").addEventListener("submit", async e => {
  e.preventDefault();
  const input = document.getElementById("messageInput");
  const body = input.value.trim();
  if (!body && !selectedFile) return;
  const file = selectedFile; input.value = ""; selectedFile = null;
  document.getElementById("filePreview").classList.add("d-none");
  try { await sendMessage(body,file); } catch (err) { toast(err.message || "تعذر إرسال الرسالة"); }
});
document.getElementById("fileInput").addEventListener("change", e => {
  selectedFile = e.target.files[0] || null;
  const preview = document.getElementById("filePreview");
  preview.textContent = selectedFile ? `المرفق: ${selectedFile.name}` : "";
  preview.classList.toggle("d-none",!selectedFile);
  e.target.value = "";
});
document.getElementById("recordBtn").addEventListener("click", async () => {
  const status = document.getElementById("recordStatus");
  if (mediaRecorder?.state === "recording") { mediaRecorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia) { toast("المتصفح لا يدعم التسجيل الصوتي أو يحتاج HTTPS"); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    audioChunks = []; mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => { if (e.data.size) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks,{type:mediaRecorder.mimeType || "audio/webm"});
      const file = new File([blob],`voice-${Date.now()}.webm`,{type:blob.type});
      try { await sendMessage("",file); status.textContent = "تم إرسال الرسالة الصوتية"; }
      catch(err) { toast(err.message); }
      setTimeout(()=>status.textContent="",3000);
    };
    mediaRecorder.start(); status.textContent = "جارٍ التسجيل... اضغط الميكروفون مرة أخرى للإيقاف والإرسال";
  } catch(err) { toast("لم يتم السماح باستخدام الميكروفون"); }
});
document.getElementById("newGroupBtn").addEventListener("click",()=>bootstrap.Modal.getOrCreateInstance(document.getElementById("groupModal")).show());
document.getElementById("startPrivateBtn").addEventListener("click",()=>bootstrap.Modal.getOrCreateInstance(document.getElementById("privateModal")).show());
document.getElementById("groupForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const name=document.getElementById("groupName").value.trim();
  const emails=document.getElementById("groupEmails").value.split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  try { await createGroup(name,emails); bootstrap.Modal.getInstance(document.getElementById("groupModal")).hide(); e.target.reset(); toast("تم إنشاء المجموعة"); }
  catch(err) { toast(err.message || "تعذر إنشاء المجموعة"); }
});
document.getElementById("privateForm").addEventListener("submit",async e=>{
  e.preventDefault();
  try { await createDirectConversation(document.getElementById("privateEmail").value); bootstrap.Modal.getInstance(document.getElementById("privateModal")).hide(); e.target.reset(); }
  catch(err) { toast(err.message || "تعذر فتح المحادثة"); }
});
document.getElementById("membersBtn").addEventListener("click",showMembers);
document.getElementById("chatSearchBtn").addEventListener("click",()=>document.getElementById("searchBar").classList.toggle("d-none"));
document.getElementById("closeSearch").addEventListener("click",()=>document.getElementById("searchBar").classList.add("d-none"));
document.getElementById("runSearch").addEventListener("click",()=>searchMessages(document.getElementById("messageSearch").value));
document.getElementById("searchInput").addEventListener("input",renderConversationList);
document.getElementById("allTab").addEventListener("click",()=>setFilter("all"));
document.getElementById("directTab").addEventListener("click",()=>setFilter("direct"));
document.getElementById("groupsTab").addEventListener("click",()=>setFilter("group"));
function setFilter(filter) {
  currentFilter=filter;
  [["allTab","all"],["directTab","direct"],["groupsTab","group"]].forEach(([id,val])=>{
    document.getElementById(id).className = val===filter ? "btn btn-sm btn-primary flex-fill" : "btn btn-sm btn-outline-secondary flex-fill";
  });
  renderConversationList();
}
document.getElementById("notifyBtn").addEventListener("click",async()=>{
  if (!("Notification" in window)) return toast("الإشعارات غير مدعومة في هذا المتصفح");
  const permission=await Notification.requestPermission();
  toast(permission==="granted"?"تم تفعيل إشعارات المتصفح":"لم يتم تفعيل الإشعارات");
});