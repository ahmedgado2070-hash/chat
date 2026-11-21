// تسجيل Service Worker اختياري للإعداد المستقبلي لإشعارات Push.
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}