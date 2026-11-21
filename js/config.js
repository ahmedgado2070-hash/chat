// ضع بيانات مشروع Supabase هنا من Project Settings > API
// استخدم Project URL و anon/public key فقط. لا تضع service_role key في المتصفح.
const SUPABASE_URL = "https://ebhwzvwqtdyepxfofgcm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_4HGiC8tE-c7V1a38cwqXNQ_xxhWF-yV";

if (!window.supabase) throw new Error("تعذر تحميل مكتبة Supabase");
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});