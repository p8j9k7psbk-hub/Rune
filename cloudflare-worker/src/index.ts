import { DurableObject } from "cloudflare:workers";

type ReminderInput = { title?: string; content?: string; scheduledAt?: string; runeName?: string; runeAvatar?: string; barkServer?: string; barkKey?: string; publicBase?: string; deviceId?: string };
type OAuthProxyInput = { url?: string; method?: string; body?: string; contentType?: string };

const json = (data: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

function cors(origin: string, env: Env): HeadersInit {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((item) => item.trim());
  const accepted = allowed.includes(origin) ? origin : allowed[0];
  return { "access-control-allow-origin": accepted, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, x-rune-device, x-rune-token", "access-control-max-age": "86400", vary: "Origin" };
}

async function sendBark(input: ReminderInput, icon?: string) {
  const server = (input.barkServer || "https://api.day.app").replace(/\/+$/, "");
  const key = input.barkKey?.trim();
  if (!key) throw new Error("没有配置 Bark Device Key");
  const response = await fetch(`${server}/${encodeURIComponent(key)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: input.runeName || "Rune", body: input.content || input.title || "Bark 连接测试", group: "Rune", ...(icon ? { icon } : {}) }) });
  const result = await response.json().catch(() => null) as { code?: number; message?: string } | null;
  if (!response.ok || (result?.code !== undefined && result.code !== 200)) throw new Error(result?.message || `Bark HTTP ${response.status}`);
  return result;
}

export class Device extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS device (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, avatar TEXT)");
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, payload TEXT NOT NULL, scheduled_at TEXT NOT NULL)");
      try { this.ctx.storage.sql.exec("ALTER TABLE device ADD COLUMN avatar TEXT"); } catch {}
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/register" && request.method === "POST") {
      const token = randomToken();
      this.ctx.storage.sql.exec("DELETE FROM device");
      this.ctx.storage.sql.exec("INSERT INTO device (id, token, avatar) VALUES (1, ?, '')", token);
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
    const body = await request.json<ReminderInput>();
    if (body.runeAvatar) this.ctx.storage.sql.exec("UPDATE device SET avatar = ? WHERE id = 1", body.runeAvatar);
    const icon = body.publicBase && body.deviceId ? `${body.publicBase}/avatar/${body.deviceId}` : undefined;
    if (url.pathname === "/bark-test" && request.method === "POST") {
      await sendBark({ ...body, content: body.content || "Bark 已经连接成功。" }, icon);
      return json({ ok: true });
    }
    if (url.pathname === "/reminder" && request.method === "POST") {
      const when = Date.parse(body.scheduledAt || "");
      if (!body.title?.trim() || !body.content?.trim() || !Number.isFinite(when)) return json({ error: "提醒内容或时间无效" }, 400);
      const reminder = { ...body, title: body.title.trim().slice(0, 100), content: body.content.trim().slice(0, 500), icon };
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
      try { const reminder = JSON.parse(row.payload) as ReminderInput & { icon?: string }; await sendBark(reminder, reminder.icon); this.ctx.storage.sql.exec("DELETE FROM reminders WHERE id = ?", row.id); }
      catch (error) { console.error(JSON.stringify({ event: "bark_failed", reminderId: row.id, message: error instanceof Error ? error.message : String(error) })); }
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
    if (url.pathname === "/health") return json({ ok: true, bark: true }, 200, headers);
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
    const target = url.pathname === "/api/reminders" ? "/reminder" : url.pathname === "/api/bark/test" ? "/bark-test" : "";
    if (!target) return json({ error: "Not found" }, 404, headers);
    const incoming = await request.json<ReminderInput>();
    const response = await env.DEVICES.getByName(deviceId).fetch(`https://device${target}`, { method: "POST", headers: request.headers, body: JSON.stringify({ ...incoming, deviceId, publicBase: url.origin }) });
    return new Response(response.body, { status: response.status, headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
  }
} satisfies ExportedHandler<Env>;
