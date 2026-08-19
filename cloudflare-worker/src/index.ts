import {
  buildPushPayload,
  type PushSubscription,
} from "@block65/webcrypto-web-push";
import { DurableObject } from "cloudflare:workers";

interface Env {
  DEVICES: DurableObjectNamespace<Device>;
  ALLOWED_ORIGIN: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

type Reminder = {
  id: string;
  title: string;
  scheduledAt: string;
};

const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const corsHeaders = (origin: string, env: Env): HeadersInit => ({
  "access-control-allow-origin":
    origin === env.ALLOWED_ORIGIN ? origin : env.ALLOWED_ORIGIN,
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "content-type, x-rune-device, x-rune-token",
  "access-control-max-age": "86400",
  vary: "Origin",
});

export class Device extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      await ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS device (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          token TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS subscriptions (
          endpoint TEXT PRIMARY KEY,
          payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reminders (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          scheduled_at TEXT NOT NULL
        );
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/register" && request.method === "POST") {
      const token = randomToken();
      this.ctx.storage.sql.exec("DELETE FROM device");
      this.ctx.storage.sql.exec(
        "INSERT INTO device (id, token) VALUES (1, ?)",
        token,
      );
      return json({ token });
    }

    if (!(await this.authorized(request))) {
      return json({ error: "设备验证失败" }, 401);
    }

    if (url.pathname === "/subscription" && request.method === "POST") {
      const subscription = (await request.json()) as PushSubscription;
      if (
        !subscription.endpoint ||
        !subscription.keys?.auth ||
        !subscription.keys?.p256dh
      ) {
        return json({ error: "无效的推送订阅" }, 400);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO subscriptions (endpoint, payload)
         VALUES (?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET payload = excluded.payload`,
        subscription.endpoint,
        JSON.stringify(subscription),
      );
      return json({ ok: true });
    }

    if (url.pathname === "/reminder" && request.method === "POST") {
      const body = (await request.json()) as Partial<Reminder>;
      const when = Date.parse(body.scheduledAt ?? "");
      if (!body.title?.trim() || !Number.isFinite(when)) {
        return json({ error: "提醒内容或时间无效" }, 400);
      }
      const reminder: Reminder = {
        id: crypto.randomUUID(),
        title: body.title.trim().slice(0, 180),
        scheduledAt: new Date(when).toISOString(),
      };
      this.ctx.storage.sql.exec(
        "INSERT INTO reminders (id, title, scheduled_at) VALUES (?, ?, ?)",
        reminder.id,
        reminder.title,
        reminder.scheduledAt,
      );
      await this.scheduleNextAlarm();
      return json({ ok: true, reminder });
    }

    return json({ error: "Not found" }, 404);
  }

  async alarm(): Promise<void> {
    const now = new Date().toISOString();
    const due = [
      ...this.ctx.storage.sql.exec<{
        id: string;
        title: string;
        scheduled_at: string;
      }>(
        "SELECT id, title, scheduled_at FROM reminders WHERE scheduled_at <= ? ORDER BY scheduled_at",
        now,
      ),
    ];
    const subscriptions = [
      ...this.ctx.storage.sql.exec<{ endpoint: string; payload: string }>(
        "SELECT endpoint, payload FROM subscriptions",
      ),
    ];

    for (const reminder of due) {
      for (const row of subscriptions) {
        try {
          const subscription = JSON.parse(row.payload) as PushSubscription;
          const payload = await buildPushPayload(
            {
              data: JSON.stringify({
                title: "Rune",
                body: reminder.title,
                url: "/",
              }),
              options: { ttl: 60 * 60, urgency: "high" },
            },
            subscription,
            {
              subject: this.env.VAPID_SUBJECT,
              publicKey: this.env.VAPID_PUBLIC_KEY,
              privateKey: this.env.VAPID_PRIVATE_KEY,
            },
          );
          const response = await fetch(subscription.endpoint, payload);
          if (response.status === 404 || response.status === 410) {
            this.ctx.storage.sql.exec(
              "DELETE FROM subscriptions WHERE endpoint = ?",
              row.endpoint,
            );
          }
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "push_failed",
              reminderId: reminder.id,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM reminders WHERE id = ?",
        reminder.id,
      );
    }
    await this.scheduleNextAlarm();
  }

  private async authorized(request: Request): Promise<boolean> {
    const supplied = request.headers.get("x-rune-token") ?? "";
    const row = [
      ...this.ctx.storage.sql.exec<{ token: string }>(
        "SELECT token FROM device WHERE id = 1",
      ),
    ][0];
    if (!row || supplied.length !== row.token.length) return false;
    const encoder = new TextEncoder();
    return crypto.subtle.timingSafeEqual(
      encoder.encode(supplied),
      encoder.encode(row.token),
    );
  }

  private async scheduleNextAlarm(): Promise<void> {
    const next = [
      ...this.ctx.storage.sql.exec<{ scheduled_at: string }>(
        "SELECT scheduled_at FROM reminders ORDER BY scheduled_at LIMIT 1",
      ),
    ][0];
    if (next) {
      await this.ctx.storage.setAlarm(
        Math.max(Date.now() + 1000, Date.parse(next.scheduled_at)),
      );
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin") ?? "";
    const cors = corsHeaders(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true }, 200, cors);
    if (url.pathname === "/api/push/key") {
      return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, cors);
    }

    if (url.pathname === "/api/devices" && request.method === "POST") {
      const deviceId = crypto.randomUUID();
      const stub = env.DEVICES.get(env.DEVICES.idFromName(deviceId));
      const response = await stub.fetch("https://device/register", {
        method: "POST",
      });
      const body = (await response.json()) as { token: string };
      return json({ deviceId, token: body.token }, 201, cors);
    }

    const deviceId = request.headers.get("x-rune-device") ?? "";
    if (!deviceId) return json({ error: "缺少设备信息" }, 400, cors);
    const stub = env.DEVICES.get(env.DEVICES.idFromName(deviceId));
    const headers = new Headers(request.headers);
    const target =
      url.pathname === "/api/push/subscriptions"
        ? "/subscription"
        : url.pathname === "/api/reminders"
          ? "/reminder"
          : "";
    if (!target) return json({ error: "Not found" }, 404, cors);

    const response = await stub.fetch(`https://device${target}`, {
      method: request.method,
      headers,
      body: request.body,
    });
    const outgoing = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) outgoing.set(key, value);
    return new Response(response.body, {
      status: response.status,
      headers: outgoing,
    });
  },
} satisfies ExportedHandler<Env>;
