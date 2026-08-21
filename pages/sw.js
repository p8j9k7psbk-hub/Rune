self.addEventListener("push", (event) => {
  event.waitUntil(self.registration.showNotification("Rune", {
    body: "你有一个新的提醒。",
    icon: "./pulse-icon-claude.png",
    badge: "./pulse-icon-claude.png",
    tag: "rune-reminder",
    data: { url: "./" },
  }));
});

function notificationTarget(rawUrl) {
  const scope = new URL(self.registration.scope);
  try {
    const candidate = new URL(rawUrl || "./", scope);
    // Notifications must stay inside the installed PWA's own origin and scope.
    if (candidate.origin !== scope.origin || !candidate.pathname.startsWith(scope.pathname)) return scope.href;
    return candidate.href;
  } catch {
    return scope.href;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
    const target = notificationTarget(event.notification.data?.url);
    const existing = windows.find((client) => {
      try {
        const url = new URL(client.url);
        return url.origin === new URL(self.registration.scope).origin;
      } catch {
        return false;
      }
    });
    if (existing) {
      if ("navigate" in existing && existing.url !== target) await existing.navigate(target);
      return existing.focus();
    }
    return clients.openWindow(target);
  }));
});
