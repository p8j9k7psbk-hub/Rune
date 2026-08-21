self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const PROFILE_CACHE = "rune-notification-profile-v1";
const PROFILE_URL = new URL("./notification-profile.json", self.registration.scope).href;
const AVATAR_URL = new URL("./notification-avatar", self.registration.scope).href;

function avatarResponse(source) {
  if (!source.startsWith("data:")) return fetch(source);
  const [header, encoded = ""] = source.split(",", 2);
  const mime = header.match(/^data:([^;,]+)/)?.[1] || "image/png";
  const binary = header.includes(";base64") ? atob(encoded) : decodeURIComponent(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return Promise.resolve(new Response(bytes, { headers: { "content-type": mime, "cache-control": "no-store" } }));
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "RUNE_NOTIFICATION_PROFILE") return;
  event.waitUntil(caches.open(PROFILE_CACHE).then(async (cache) => {
    let icon = "./pulse-icon-claude.png";
    if (event.data.avatar) {
      try {
        await cache.put(AVATAR_URL, await avatarResponse(event.data.avatar));
        icon = AVATAR_URL;
      } catch {}
    }
    await cache.put(PROFILE_URL, new Response(JSON.stringify({ name: event.data.name || "Rune", icon }), { headers: { "content-type": "application/json" } }));
  }));
});

async function notificationProfile() {
  try {
    const cached = await caches.match(PROFILE_URL);
    if (cached) return await cached.json();
  } catch {}
  return { name: "Rune", icon: "./pulse-icon-claude.png" };
}

// 后端推送的负载形如 { title, body, url }。
// 之前这里忽略了 event.data，导致每条提醒都显示成同一句占位文案。
self.addEventListener("push", (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      try {
        payload = { body: event.data.text() };
      } catch {
        payload = {};
      }
    }
  }
  event.waitUntil(notificationProfile().then((profile) => {
    const content = [payload.title, payload.body].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join("\n") || "你有一个新的提醒。";
    return self.registration.showNotification(profile.name || "Rune", {
    body: content,
    icon: profile.icon || "./pulse-icon-claude.png",
    badge: profile.icon || "./pulse-icon-claude.png",
    image: profile.icon || undefined,
    // 每条提醒用不同的 tag，否则后到的会把前一条顶掉
    tag: `rune-reminder-${payload.id || Date.now()}`,
    data: { url: payload.url || "./" },
    });
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const target = new URL(event.notification.data?.url || "./", self.registration.scope).href;
    const existing = windows[0];
    if (existing) return existing.navigate(target).then((client) => client?.focus());
    return clients.openWindow(target);
  }));
});
