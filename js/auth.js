let authMode = "login";
const authView = document.getElementById("authView");
const appView = document.getElementById("appView");
const authForm = document.getElementById("authForm");
const authMessage = document.getElementById("authMessage");

function setAuthMode(mode) {
  authMode = mode;
  document.getElementById("nameField").classList.toggle("d-none", mode !== "signup");
  document.getElementById("authSubmit").textContent = mode === "signup" ? "إنشاء الحساب" : "دخول";
  document.getElementById("showLogin").className = mode === "login" ? "btn btn-primary" : "btn btn-outline-primary";
  document.getElementById("showSignup").className = mode === "signup" ? "btn btn-primary" : "btn btn-outline-primary";
  document.getElementById("password").autocomplete = mode === "signup" ? "new-password" : "current-password";
  authMessage.textContent = "";
}
document.getElementById("showLogin").addEventListener("click", () => setAuthMode("login"));
document.getElementById("showSignup").addEventListener("click", () => setAuthMode("signup"));

authForm.addEventListener("submit", async e => {
  e.preventDefault();
  const email = document.getElementById("email").value.trim().toLowerCase();
  const password = document.getElementById("password").value;
  const displayName = document.getElementById("displayName").value.trim();
  const button = document.getElementById("authSubmit");
  button.disabled = true; authMessage.textContent = "جارٍ التنفيذ...";
  try {
    let result;
    if (authMode === "signup") {
      result = await db.auth.signUp({ email, password, options: { data: { display_name: displayName || email.split("@")[0] } } });
      if (!result.error && !result.data.session) authMessage.textContent = "تم إنشاء الحساب. افحص بريدك الإلكتروني لتأكيد التسجيل ثم سجّل الدخول.";
    } else {
      result = await db.auth.signInWithPassword({ email, password });
    }
    if (result.error) throw result.error;
    if (result.data.session) await showApp(result.data.session.user);
  } catch (err) { authMessage.textContent = err.message || "حدث خطأ غير متوقع"; authMessage.className = "small mt-3 text-danger"; }
  finally { button.disabled = false; }
});

async function showApp(user) {
  authView.classList.add("d-none"); appView.classList.remove("d-none");
  const name = user.user_metadata?.display_name || user.email?.split("@")[0] || "مستخدم";
  document.getElementById("myName").textContent = name;
  document.getElementById("myAvatar").textContent = name.slice(0,1).toUpperCase();
  window.currentUser = user;
  await loadConversations();
}
async function checkSession() {
  const { data: { session } } = await db.auth.getSession();
  if (session) await showApp(session.user);
}
db.auth.onAuthStateChange((_event, session) => {
  if (!session) { appView.classList.add("d-none"); authView.classList.remove("d-none"); }
});
document.getElementById("logoutBtn").addEventListener("click", async () => { await db.auth.signOut(); });
checkSession();