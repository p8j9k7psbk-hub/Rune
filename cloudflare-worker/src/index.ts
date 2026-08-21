import { DurableObject } from "cloudflare:workers";
import { buildPushPayload, type PushSubscription, type VapidKeys } from "@block65/webcrypto-web-push";

type ReminderInput = { title?: string; content?: string; scheduledAt?: string; mode?: "reminder" | "alarm" | "call"; appUrl?: string; runeName?: string; runeAvatar?: string };
type OAuthProxyInput = { url?: string; method?: string; body?: string; contentType?: string };

const json = (data: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const fromBase64Url = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), (character) => character.charCodeAt(0));

function cors(origin: string, env: Env): HeadersInit {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((item) => item.trim());
  const accepted = allowed.includes(origin) ? origin : allowed[0];
  return { "access-control-allow-origin": accepted, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, x-rune-device, x-rune-token", "access-control-max-age": "86400", vary: "Origin" };
}

export class Device extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS device (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, avatar TEXT, subscription TEXT, vapid_public TEXT, vapid_private TEXT)");
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, payload TEXT NOT NULL, scheduled_at TEXT NOT NULL)");
      try { this.ctx.storage.sql.exec("ALTER TABLE device ADD COLUMN avatar TEXT"); } catch {}
      try { this.ctx.storage.sql.exec("ALTER TABLE device ADD COLUMN subscription TEXT"); } catch {}
      try { this.ctx.storage.sql.exec("ALTER TABLE device ADD COLUMN vapid_public TEXT"); } catch {}
      try { this.ctx.storage.sql.exec("ALTER TABLE device ADD COLUMN vapid_private TEXT"); } catch {}
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/register" && request.method === "POST") {
      const token = randomToken();
      this.ctx.storage.sql.exec("DELETE FROM device");
      this.ctx.storage.sql.exec("INSERT INTO device (id, token, avatar, subscription, vapid_public, vapid_private) VALUES (1, ?, '', '', '', '')", token);
      return json({ token });
    }
    if (url.pathname === "/avatar") {
      const avatar = [...this.ctx.storage.sql.exec<{ avatar: string }>("SELECT avatar FROM device WHERE id = 1")][0]?.avatar || "";
      const match = avatar.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return new Response(null, { status: 404 });
      const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0));
      return new Response(bytes, { headers: { "content-type": match[1], "cache-control": "public, max-age=3600" } });
    }
    if (!(await this.authorized(request))) return json({ error: "设备验证失败" }, 401);
    if (url.pathname === "/push-key" && request.method === "GET") {
      const vapid = await this.ensureVapidKeys();
      return json({ publicKey: vapid.publicKey });
    }
    if (url.pathname === "/push-subscription" && request.method === "POST") {
      const subscription = await request.json<PushSubscription>();
      if (!subscription.endpoint?.startsWith("https://") || !subscription.keys?.auth || !subscription.keys?.p256dh) return json({ error: "Web Push 订阅无效" }, 400);
      this.ctx.storage.sql.exec("UPDATE device SET subscription = ? WHERE id = 1", JSON.stringify(subscription));
      return json({ ok: true });
    }
    const body = await request.json<ReminderInput>();
    if (body.runeAvatar) this.ctx.storage.sql.exec("UPDATE device SET avatar = ? WHERE id = 1", body.runeAvatar);
    if (url.pathname === "/push-test" && request.method === "POST") {
      await this.sendWebPush({ ...body, title: body.title || "Rune 通知测试", content: body.content || "Web Push 已经连接成功。" });
      return json({ ok: true });
    }
    if (url.pathname === "/reminder" && request.method === "POST") {
      const when = Date.parse(body.scheduledAt || "");
      if (!body.title?.trim() || !body.content?.trim() || !Number.isFinite(when)) return json({ error: "提醒内容或时间无效" }, 400);
      const reminder = { ...body, title: body.title.trim().slice(0, 100), content: body.content.trim().slice(0, 500) };
      const id = crypto.randomUUID();
      const scheduledAt = new Date(when).toISOString();
      this.ctx.storage.sql.exec("INSERT INTO reminders (id, payload, scheduled_at) VALUES (?, ?, ?)", id, JSON.stringify(reminder), scheduledAt);
      await this.scheduleNextAlarm();
      return json({ ok: true, reminder: { id, title: reminder.title, content: reminder.content, scheduledAt } });
    }
    return json({ error: "Not found" }, 404);
  }

  async alarm() {
    const due = [...this.ctx.storage.sql.exec<{ id: string; payload: string }>("SELECT id, payload FROM reminders WHERE scheduled_at <= ? ORDER BY scheduled_at", new Date().toISOString())];
    for (const row of due) {
      try { const reminder = JSON.parse(row.payload) as ReminderInput; await this.sendWebPush(reminder); }
      catch (error) { console.error(JSON.stringify({ event: "web_push_failed", reminderId: row.id, message: error instanceof Error ? error.message : String(error) })); }
      finally { this.ctx.storage.sql.exec("DELETE FROM reminders WHERE id = ?", row.id); }
    }
    await this.scheduleNextAlarm();
  }

  private async authorized(request: Request) {
    const supplied = request.headers.get("x-rune-token") || "";
    const saved = [...this.ctx.storage.sql.exec<{ token: string }>("SELECT token FROM device WHERE id = 1")][0]?.token || "";
    if (!saved || supplied.length !== saved.length) return false;
    const [left, right] = await Promise.all([supplied, saved].map((value) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
    const a = new Uint8Array(left); const b = new Uint8Array(right); let difference = 0;
    for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
    return difference === 0;
  }
  private async ensureVapidKeys(): Promise<VapidKeys> {
    const existing = [...this.ctx.storage.sql.exec<{ vapid_public: string; vapid_private: string }>("SELECT vapid_public, vapid_private FROM device WHERE id = 1")][0];
    if (existing?.vapid_public && existing.vapid_private) return { subject: "https://rune.r-vera.com", publicKey: existing.vapid_public, privateKey: existing.vapid_private };
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const [publicJwk, privateJwk] = await Promise.all([
      crypto.subtle.exportKey("jwk", pair.publicKey),
      crypto.subtle.exportKey("jwk", pair.privateKey),
    ]) as [JsonWebKey, JsonWebKey];
    if (!publicJwk.x || !publicJwk.y || !privateJwk.d) throw new Error("VAPID 密钥生成失败");
    const x = fromBase64Url(publicJwk.x); const y = fromBase64Url(publicJwk.y);
    const publicBytes = new Uint8Array(1 + x.length + y.length);
    publicBytes[0] = 4; publicBytes.set(x, 1); publicBytes.set(y, 1 + x.length);
    const publicKey = base64Url(publicBytes); const privateKey = privateJwk.d;
    this.ctx.storage.sql.exec("UPDATE device SET vapid_public = ?, vapid_private = ? WHERE id = 1", publicKey, privateKey);
    return { subject: "https://rune.r-vera.com", publicKey, privateKey };
  }
  private async sendWebPush(input: ReminderInput) {
    const row = [...this.ctx.storage.sql.exec<{ subscription: string }>("SELECT subscription FROM device WHERE id = 1")][0];
    if (!row?.subscription) throw new Error("这台设备还没有开启 Web Push");
    const subscription = JSON.parse(row.subscription) as PushSubscription;
    const mode = input.mode || "reminder";
    const appUrl = input.appUrl?.startsWith("https://") ? input.appUrl.replace(/\/+$/, "") : "https://rune.r-vera.com";
    const openUrl = `${appUrl}/?${new URLSearchParams({ rune_surface: mode, title: input.title || "Rune", content: input.content || "" })}`;
    const payload = await buildPushPayload({ data: JSON.stringify({ id: crypto.randomUUID(), title: input.title || "Rune", body: input.content || "你有一个新的提醒。", url: openUrl, mode }), options: { ttl: 86400, urgency: mode === "reminder" ? "normal" : "high" } }, subscription, await this.ensureVapidKeys());
    const response = await fetch(subscription.endpoint, payload);
    if (response.status === 404 || response.status === 410) this.ctx.storage.sql.exec("UPDATE device SET subscription = '' WHERE id = 1");
    if (!response.ok) throw new Error(`Push service HTTP ${response.status}`);
  }
  private async scheduleNextAlarm() {
    const next = [...this.ctx.storage.sql.exec<{ scheduled_at: string }>("SELECT scheduled_at FROM reminders ORDER BY scheduled_at LIMIT 1")][0];
    if (next) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Date.parse(next.scheduled_at))); else await this.ctx.storage.deleteAlarm();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin") || "";
    const headers = cors(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { headers });
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, webPush: true }, 200, headers);
    if (url.pathname === "/api/mcp-oauth/proxy" && request.method === "POST") {
      const input = await request.json<OAuthProxyInput>();
      let upstream: URL;
      try { upstream = new URL(input.url || ""); } catch { return json({ error: "OAuth 地址无效" }, 400, headers); }
      const allowedPaths = new Set(["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/oauth/register", "/oauth/token"]);
      if (upstream.protocol !== "https:" || upstream.hostname !== "galatea.abysslumina.com" || !allowedPaths.has(upstream.pathname)) return json({ error: "OAuth 地址不在允许范围" }, 403, headers);
      const method = input.method === "POST" ? "POST" : "GET";
      const response = await fetch(upstream, { method, headers: method === "POST" ? { "content-type": input.contentType || "application/json" } : undefined, body: method === "POST" ? input.body || "" : undefined });
      return new Response(response.body, { status: response.status, headers: { ...headers, "content-type": response.headers.get("content-type") || "application/json; charset=utf-8" } });
    }
    if (url.pathname === "/api/devices" && request.method === "POST") {
      const deviceId = crypto.randomUUID();
      const response = await env.DEVICES.getByName(deviceId).fetch("https://device/register", { method: "POST" });
      const body = await response.json<{ token: string }>();
      return json({ deviceId, token: body.token }, 201, headers);
    }
    const avatarMatch = url.pathname.match(/^\/avatar\/([a-f0-9-]+)$/i);
    if (avatarMatch) return env.DEVICES.getByName(avatarMatch[1]).fetch("https://device/avatar");
    const deviceId = request.headers.get("x-rune-device") || "";
    if (!deviceId) return json({ error: "缺少设备信息" }, 400, headers);
    const target = url.pathname === "/api/reminders" ? "/reminder"
      : url.pathname === "/api/push/key" ? "/push-key"
      : url.pathname === "/api/push/subscriptions" ? "/push-subscription"
      : url.pathname === "/api/push/test" ? "/push-test"
      : "";
    if (!target) return json({ error: "Not found" }, 404, headers);
    if (request.method === "GET") {
      const response = await env.DEVICES.getByName(deviceId).fetch(`https://device${target}`, { method: "GET", headers: request.headers });
      return new Response(response.body, { status: response.status, headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
    }
    const incoming = await request.json<ReminderInput | PushSubscription>();
    const response = await env.DEVICES.getByName(deviceId).fetch(`https://device${target}`, { method: "POST", headers: request.headers, body: JSON.stringify(incoming) });
    return new Response(response.body, { status: response.status, headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
  }
} satisfies ExportedHandler<Env>;
