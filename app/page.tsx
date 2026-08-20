"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import "./mobile-fixes.css";

type Tab = "home" | "chat" | "diary" | "settings";
type ThemeName = "paper" | "sage" | "ink" | "claude";
type Anniversary = { id: number; name: string; date: string };
type HealthSummary = { steps?: number; heartRate?: number; importedAt?: string; week?: number[] };
type McpServer = { id: number; name: string; url: string; enabled: boolean; authMode?: "none" | "oauth"; requiresAuth?: boolean; token?: string };
type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type Todo = { id: number; text: string; meta: string; done: boolean };
type ClaudeModel = { id: string; display_name: string; created_at?: string };
type ChatAttachment = { id: number; name: string; kind: "image" | "text"; mediaType: string; data: string };
type ToolTrace = { name: string; server?: string; input?: unknown; output?: unknown; status: "完成" | "失败" | "等待确认" };
type TokenUsage = { input: number; output: number; total: number };
type ChatMessage = { role: "user" | "assistant"; text: string; attachments?: ChatAttachment[]; voice?: boolean; reasoning?: string; toolTraces?: ToolTrace[]; usage?: TokenUsage };
type RuneAction = { id: string; name: "add_todo" | "write_diary" | "set_home_message" | "create_reminder"; input: Record<string, string>; status: "pending" | "done" | "cancelled" };
type Profile = {
  name: string;         // Rune 的昵称
  avatar: string;       // Rune 的头像，dataURL；留空则显示昵称首字
  userName: string;     // 你的昵称
  userAvatar: string;   // 你的头像
  instructions: string;
};

const defaultProfile: Profile = {
  name: "Rune",
  avatar: "",
  userName: "user",
  userAvatar: "",
  instructions: "你是 Rune，一个安静、真诚、有温度的私人陪伴助手。使用简洁自然的中文回答。",
};

// 手机照片直接转 base64 有好几 MB，存两张就吃掉大半配额。
// 统一居中裁成正方形并缩到 160px，一张大约 8KB。
async function readAvatar(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("图片读取失败"));
      element.src = dataUrl;
    });
    const size = 160;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    const side = Math.min(image.width, image.height);
    context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return dataUrl;
  }
}

function initialOf(name: string, fallback: string) {
  return (name.trim() || fallback).slice(0, 1);
}

type ApiProtocol = "anthropic" | "openai";

function normalizeAiApiBase(value: string) {
  return value.trim().replace(/\/+$/, "").replace(/\/models$/, "").replace(/\/chat\/completions$/, "").replace(/\/messages$/, "");
}

function apiProtocolFor(base: string): ApiProtocol {
  return /(^|\.)anthropic\.com\b|\/anthropic\b/i.test(base) ? "anthropic" : "openai";
}

function parseMcpPayload(text: string) {
  const direct = text.trim();
  if (!direct) return null;
  if (!direct.startsWith("data:")) return JSON.parse(direct);
  const data = direct.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim()).filter((line) => line && line !== "[DONE]").at(-1);
  return data ? JSON.parse(data) : null;
}

async function callMcpRpc(server: McpServer, method: string, params: Record<string, unknown>, sessionId?: string) {
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(server.token ? { authorization: `Bearer ${server.token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: `${Date.now()}-${Math.random()}`, method, params }),
  });
  if (!response.ok) throw new Error(`${server.name} MCP 返回 HTTP ${response.status}`);
  const payload = parseMcpPayload(await response.text());
  if (payload?.error) throw new Error(payload.error.message || `${server.name} MCP 调用失败`);
  return { result: payload?.result, sessionId: response.headers.get("mcp-session-id") || sessionId };
}

async function notifyMcpInitialized(server: McpServer, sessionId?: string) {
  await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(server.token ? { authorization: `Bearer ${server.token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function startMcpOAuth(server: McpServer) {
  const endpoint = new URL(server.url);
  const metadataUrl = new URL("/.well-known/oauth-authorization-server", endpoint.origin);
  const metadataResponse = await fetch(metadataUrl);
  if (!metadataResponse.ok) throw new Error(`无法读取 OAuth 配置（HTTP ${metadataResponse.status}）`);
  const metadata = await metadataResponse.json();
  if (!metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.registration_endpoint) throw new Error("这个 MCP 没有提供可自动跳转的 OAuth 动态注册信息。");
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const redirectUri = `${location.origin}${location.pathname}`;
  const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  const registrationResponse = await fetch(metadata.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Rune", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  const registration = await registrationResponse.json();
  if (!registrationResponse.ok || !registration.client_id) throw new Error(registration.error_description || "OAuth 客户端自动注册失败。");
  const clientId = String(registration.client_id);
  localStorage.setItem("rune-mcp-oauth-pending", JSON.stringify({ serverId: server.id, verifier, state, redirectUri, tokenEndpoint: metadata.token_endpoint, clientId }));
  const authorize = new URL(metadata.authorization_endpoint);
  authorize.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state }).toString();
  location.assign(authorize.href);
}

type StoredConversation = { id: number; title: string; updatedAt: number; messages: ChatMessage[] };

const CHAT_HISTORY_KEY = "rune-chat-history";
const MAX_CONVERSATIONS = 200;

// 附件里的图片是 base64，一张手机照片就有几 MB，而 localStorage 配额通常只有 5MB。
// 所以不预先剥离，而是照常存；写不下时由 persistConversations 淘汰最旧的对话，
// 实在存不下才退化成只保留文件名。这样近期对话能留住图片。
function stripAttachmentData(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) =>
    message.attachments?.length
      ? { ...message, attachments: message.attachments.map((a) => ({ ...a, data: "" })) }
      : message,
  );
}

// 写入历史，超配额就从最旧的开始丢，直到写得下。
function persistConversations(list: StoredConversation[]): { saved: StoredConversation[]; dropped: number } {
  let working = list;
  let dropped = 0;
  for (;;) {
    try {
      localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(working));
      return { saved: working, dropped };
    } catch {
      if (working.length > 1) {
        working = working.slice(0, -1);
        dropped += 1;
        continue;
      }
      // 只剩一条还写不下，说明附件太大：退化成只保留文件名
      try {
        const lean = working.map((c) => ({ ...c, messages: stripAttachmentData(c.messages) }));
        localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(lean));
        return { saved: lean, dropped };
      } catch {
        return { saved: working, dropped };
      }
    }
  }
}

function conversationTitle(messages: ChatMessage[]) {
  const first = messages.find((m) => m.role === "user" && m.text.trim())?.text
    || messages.find((m) => m.text.trim())?.text
    || "新对话";
  const clean = first.replace(/\s+/g, " ").trim();
  return clean.length > 18 ? `${clean.slice(0, 18)}…` : clean;
}

function conversationTime(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((today.getTime() - new Date(date).setHours(0, 0, 0, 0)) / 86400000);
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (days <= 0) return time;
  if (days === 1) return `昨天 ${time}`;
  if (days < 7) return `${days} 天前`;
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

// 首页那张卡片分两行显示：第一句做标题，剩下的做副文本。
function splitHomeMessage(text: string) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return { title: "今天也辛苦了。", sub: "" };
  const match = clean.match(/^(.{1,26}?[。！？!?.])\s*(.*)$/);
  if (match) return { title: match[1], sub: match[2].slice(0, 44) };
  return { title: clean.slice(0, 26), sub: clean.slice(26, 70) };
}

const themes: Record<ThemeName, { label: string; swatch: string }> = {
  paper: { label: "纸白", swatch: "#f2f0e9" },
  sage: { label: "苔绿", swatch: "#698266" },
  ink: { label: "夜墨", swatch: "#262724" },
  claude: { label: "Claude", swatch: "#d97757" },
};

const defaultAnniversaries: Anniversary[] = [];

const defaultMcpServers: McpServer[] = [
  { id: 1, name: "Notion", url: "https://mcp.notion.com/mcp", enabled: false, requiresAuth: true },
];

// 纪念日是每年重复的：今年的这天过了就顺延到明年，而不是永远停在 0。
function daysUntil(date: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return 0;
  const target = new Date(today.getFullYear(), parsed.getMonth(), parsed.getDate());
  if (target.getTime() < today.getTime()) target.setFullYear(target.getFullYear() + 1);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function daysTogether(date: string) {
  if (!date) return null;
  const start = new Date(`${date}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(1, Math.floor((today.getTime() - start.getTime()) / 86400000) + 1);
}

type VoiceClip = { url: string; duration: number };
const VOICE_MARK = /^\s*\[\[voice\]\]\s*/i;

type VoiceConfig = {
  endpoint: string;
  groupId: string;
  voiceId: string;
  model: string;
  speed: number;
  autoPlay: boolean;   // Rune 回复后自动朗读
};

const defaultVoiceConfig: VoiceConfig = {
  endpoint: "https://api.minimax.chat/v1/t2a_v2",
  groupId: "",
  voiceId: "",
  model: "speech-02-hd",
  speed: 1,
  autoPlay: false,
};

// MiniMax Key 与通用 AI 配置保存在当前设备的 localStorage，不上传到 Rune 后端。
const MINIMAX_KEY_STORAGE = "rune-minimax-key";

function hexToBytes(hex: string) {
  const clean = hex.trim();
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// MiniMax T2A：音频以十六进制字符串放在 data.audio 里，转成 Blob URL 交给 <audio> 播。
async function synthesizeSpeech(text: string, config: VoiceConfig, apiKey: string): Promise<string> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("没有可朗读的内容。");
  if (!apiKey) throw new Error("还没填 MiniMax API Key，去 Settings → 语音 里填。");
  if (!config.voiceId) throw new Error("还没填 Voice ID。");
  const base = (config.endpoint || defaultVoiceConfig.endpoint).replace(/\/+$/, "");
  const url = config.groupId ? `${base}?GroupId=${encodeURIComponent(config.groupId)}` : base;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: config.model || defaultVoiceConfig.model,
      text: clean.slice(0, 4000),
      stream: false,
      output_format: "hex",
      voice_setting: { voice_id: config.voiceId, speed: config.speed || 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    }),
  });
  const body = await response.text();
  let data: Record<string, never> | null = null;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`合成失败：后端没有返回 JSON（HTTP ${response.status}）。`);
  }
  const resp = (data as Record<string, { status_code?: number; status_msg?: string }> | null)?.base_resp;
  if (!response.ok || (resp?.status_code !== undefined && resp.status_code !== 0)) {
    throw new Error(`合成失败：${resp?.status_msg || `HTTP ${response.status}`}`);
  }
  const audio = (data as Record<string, { audio?: string }> | null)?.data?.audio;
  if (!audio) throw new Error("合成失败：返回里没有音频数据。");
  return URL.createObjectURL(new Blob([hexToBytes(audio)], { type: "audio/mpeg" }));
}

// 浏览器自带的语音识别。Safari 走 webkit 前缀；不支持时返回 null，界面据此降级。
function speechRecognitionClass(): (new () => SpeechRecognitionLike) | null {
  const scope = globalThis as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return scope.SpeechRecognition || scope.webkitSpeechRecognition || null;
}

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function MicrophoneIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.8 10.5a6.2 6.2 0 0 0 12.4 0M12 16.7V21M8.8 21h6.4"/></svg>;
}

function PhoneIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7.2 3.8 4.8 5.5c-.8.6-.9 1.8-.5 2.7 2.2 5.3 6.2 9.3 11.5 11.5.9.4 2.1.3 2.7-.5l1.7-2.4c.5-.7.3-1.7-.5-2.1l-3.4-1.7c-.7-.3-1.5-.1-1.9.5l-.8 1.2a14.2 14.2 0 0 1-4.3-4.3l1.2-.8c.6-.4.8-1.2.5-1.9L9.3 4.3c-.4-.8-1.4-1-2.1-.5Z"/></svg>;
}

// 每次请求都把"此刻"算一遍塞进 system prompt。
// 不做成工具是因为工具结果要靠 tool_result 回传，而那条链路目前还没闭环。
function nowContext() {
  const now = new Date();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Singapore";
  const full = now.toLocaleString("zh-CN", {
    year: "numeric", month: "long", day: "numeric",
    weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return `现在是 ${full}（${zone}，ISO：${now.toISOString()}）。涉及"今天/明天/几点"一律以此为准，不要自己猜。`;
}

function greetingFor(date: Date) {
  const hour = date.getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function relativeTime(timestamp: number | null) {
  if (!timestamp) return "";
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

// 提醒后端（cloudflare-worker/ 里的 rune-push）部署后，把地址填进 Settings。
// 同源部署（例如 chatgpt.site 那份）留空即可，请求会直接打到自己。
const RUNE_API_STORAGE_KEY = "rune-api-base";
const SAME_ORIGIN_API_HOSTS = ["pulse-private-space.q6r6nrp7qy.chatgpt.site"];
// cloudflare-worker/ 部署后的地址，作为默认值，开箱即用。
// 注意 worker 的 ALLOWED_ORIGIN 只认 GitHub Pages 那个域名，
// 所以本地 localhost 预览会被 CORS 拦掉，属于预期行为。
const DEFAULT_RUNE_API_BASE = "https://rune-push.r-vera.com";

function runeApiBase() {
  if (typeof globalThis.location === "undefined") return "";
  if (SAME_ORIGIN_API_HOSTS.includes(globalThis.location.hostname)) return "";
  const stored = localStorage.getItem(RUNE_API_STORAGE_KEY);
  if (stored?.includes("rune-push.che061029.workers.dev")) {
    localStorage.setItem(RUNE_API_STORAGE_KEY, DEFAULT_RUNE_API_BASE);
    return DEFAULT_RUNE_API_BASE;
  }
  return (stored ?? DEFAULT_RUNE_API_BASE).replace(/\/+$/, "");
}

async function syncNotificationProfile(profile: Profile) {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.ready.catch(() => null);
  const worker = registration?.active || navigator.serviceWorker.controller;
  worker?.postMessage({ type: "RUNE_NOTIFICATION_PROFILE", name: profile.name || "Rune", avatar: profile.avatar || "" });
}

// 后端可能返回 HTML（登录墙、404 页），直接 .json() 会抛出难懂的 SyntaxError。
// 这里统一转成人能看懂的说明。
async function readJson(response: Response, what: string) {
  const body = await response.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(body) as Record<string, unknown>;
  } catch {
    data = null;
  }
  if (!response.ok || !data) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${what}失败：提醒后端需要登录（HTTP ${response.status}），这个部署上还用不了。`);
    }
    if (!data) {
      throw new Error(`${what}失败：后端没有返回数据（HTTP ${response.status}），可能地址配置不对。`);
    }
    throw new Error(`${what}失败：${String(data.error || `HTTP ${response.status}`)}`);
  }
  return data;
}

async function ensureRuneDevice() {
  let deviceId = localStorage.getItem("rune-device-id") || "";
  let deviceToken = localStorage.getItem("rune-device-token") || "";
  if (!deviceId || !deviceToken) {
    const device = await readJson(await fetch(`${runeApiBase()}/api/devices`, { method: "POST" }), "注册设备");
    deviceId = String(device.deviceId || "");
    deviceToken = String(device.token || "");
    if (!deviceId || !deviceToken) throw new Error("注册设备失败。");
    localStorage.setItem("rune-device-id", deviceId);
    localStorage.setItem("rune-device-token", deviceToken);
  }
  return { deviceId, deviceToken };
}

function decodeBase64Url(value: string) {
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - value.length % 4) % 4)}`;
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

const initialTodos: Todo[] = [];

function HeaderButton({
  label,
  children,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button className="icon-button" aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

function HomeView({
  goDiary,
  goChat,
  goSettings,
  anniversaries,
  health,
  metDate,
  homeMessage,
  homeMessageAt,
  profile,
}: {
  goDiary: () => void;
  goChat: () => void;
  goSettings: () => void;
  anniversaries: Anniversary[];
  health: HealthSummary;
  metDate: string;
  homeMessage: string;
  homeMessageAt: number | null;
  profile: Profile;
}) {
  const mainAnniversary = anniversaries[0];
  const knownDays = daysTogether(metDate);
  const homeThought = useMemo(() => splitHomeMessage(homeMessage), [homeMessage]);
  const now = useMemo(() => new Date(), []);
  const todayLabel = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  return (
    <main className="page home-page">
      <header className="home-header">
        <div>
          <p className="eyebrow">{todayLabel}</p>
          <h1>{greetingFor(now)}, {profile.userName || "user"}</h1>
        </div>
        <HeaderButton label="打开设置" onClick={goSettings}>
          <span className="sun-icon">☼</span>
        </HeaderButton>
      </header>

      <button className="thought-card dark-card" onClick={goChat}>
        <span className="mini-avatar">{profile.avatar ? <img src={profile.avatar} alt="" /> : initialOf(profile.name, "R")}</span>
        <span>
          <strong>{homeThought.title}</strong>
          <small>{homeThought.sub || "慢一点没关系，我会一直在。"}</small>
        </span>
        <span className="thought-time">{relativeTime(homeMessageAt)}</span>
      </button>

      <section className="glass-card day-card">
        <p className="eyebrow">Us</p>
        <div className="day-row">
          <div>
            <h2>{knownDays ? `Day ${knownDays}` : "设置日期"}</h2>
            <p>{knownDays ? `和 Rune 认识的第 ${knownDays} 天` : "前往设置填写和 Rune 认识的日期"}</p>
          </div>
          <span className="soft-heart">♥</span>
        </div>
      </section>

      <button className="glass-card anniversary-card editable-card" onClick={goSettings}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">Next Anniversary</p>
            <strong>{mainAnniversary?.name || "添加纪念日"}</strong>
          </div>
          <div className="countdown">
            <span>{mainAnniversary ? daysUntil(mainAnniversary.date) : "＋"}</span>
            <small>days</small>
          </div>
        </div>
        <div className="date-facts compact-facts">
          {anniversaries.slice(1, 3).map((item) => (
            <div key={item.id}><span>{item.name}</span><strong>{daysUntil(item.date)}</strong><small>days</small></div>
          ))}
        </div>
        <span className="edit-hint">点按编辑</span>
      </button>

      <section className="metrics-grid">
        <article className="glass-card metric-card" onClick={goSettings}>
          <p>Steps <small>{health.importedAt ? "已导入" : "未连接"}</small></p>
          <h3>{health.steps?.toLocaleString() ?? "—"}</h3>
          {health.week?.length ? (
            <div className="bars" aria-label="近七日步数">
              {health.week.map((value, i) => (
                <i key={i} style={{ height: Math.max(4, Math.round((value / Math.max(...health.week!)) * 64)) }} />
              ))}
            </div>
          ) : (
            <small>前往设置导入 Health 数据</small>
          )}
        </article>
        <article className="glass-card metric-card" onClick={goSettings}>
          <p>Heart Rate <small>{health.importedAt ? "最新" : "未连接"}</small></p>
          <h3>{health.heartRate ?? "—"}{health.heartRate && <small> bpm</small>}</h3>
          {health.heartRate ? <div className="heartbeat">⌁⌁╱╲⌁╱╲⌁</div> : null}
          <small>{health.importedAt ? `导入于 ${health.importedAt}` : "前往设置导入 Health 数据"}</small>
        </article>
        <article className="glass-card metric-card cycle-card" onClick={goSettings}>
          <p>Health <small>Apple</small></p>
          <div className="cycle-value"><span>♥</span><strong>{health.importedAt ? "已导入" : "连接"}</strong></div>
          <small>{health.importedAt ? "数据保存在此设备" : "导入 Apple Health export"}</small>
        </article>
      </section>

      <button className="primary-action" onClick={goDiary}>
        查看今天 <span>→</span>
      </button>
    </main>
  );
}

function DiaryView({ profile }: { profile: Profile }) {
  const [mode, setMode] = useState<"mine" | "rune">("mine");
  const today = useMemo(() => new Date(), []);
  const todayKey = localDateKey(today);
  const [selectedDate, setSelectedDate] = useState(today);
  const [calendarMonth, setCalendarMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [todosByDate, setTodosByDate] = useState<Record<string, Todo[]>>({ [todayKey]: initialTodos });
  const [newTodo, setNewTodo] = useState("");
  const [diaryByDate, setDiaryByDate] = useState<Record<string, string>>({});
  const [runeDiaryByDate, setRuneDiaryByDate] = useState<Record<string, string>>({});
  const [editingDiary, setEditingDiary] = useState(false);
  const [diaryDraft, setDiaryDraft] = useState("");
  const selectedKey = localDateKey(selectedDate);
  const todos = todosByDate[selectedKey] || [];

  const pending = todos.filter((todo) => !todo.done).length;

  const toggleTodo = (id: number) => {
    setTodosByDate((all) => ({
      ...all,
      [selectedKey]: todos.map((item) => (item.id === id ? { ...item, done: !item.done } : item)),
    }));
  };

  const addTodo = () => {
    if (!newTodo.trim()) return;
    setTodosByDate((all) => ({
      ...all,
      [selectedKey]: [...(all[selectedKey] || []), { id: Date.now(), text: newTodo.trim(), meta: selectedKey === todayKey ? "今天" : selectedDate.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }), done: false }],
    }));
    setNewTodo("");
  };

  useEffect(() => {
    if (typeof globalThis.document === "undefined") return;
    const stored = localStorage.getItem("pulse-diary-todos");
    if (stored) setTodosByDate(JSON.parse(stored));
  }, []);

  useEffect(() => {
    if (typeof globalThis.document === "undefined") return;
    localStorage.setItem("pulse-diary-todos", JSON.stringify(todosByDate));
  }, [todosByDate]);

  useEffect(() => {
    if (typeof globalThis.document === "undefined") return;
    const stored = localStorage.getItem("pulse-diary-entries");
    if (stored) setDiaryByDate(JSON.parse(stored));
  }, []);

  useEffect(() => {
    if (typeof globalThis.document === "undefined") return;
    localStorage.setItem("pulse-diary-entries", JSON.stringify(diaryByDate));
  }, [diaryByDate]);

  useEffect(() => {
    if (typeof globalThis.document === "undefined") return;
    const stored = localStorage.getItem("pulse-rune-diary-entries");
    if (stored) setRuneDiaryByDate(JSON.parse(stored));
  }, []);

  useEffect(() => {
    if (typeof globalThis.document === "undefined") return;
    localStorage.setItem("pulse-rune-diary-entries", JSON.stringify(runeDiaryByDate));
  }, [runeDiaryByDate]);

  useEffect(() => {
    setDiaryDraft(diaryByDate[selectedKey] || "");
    setEditingDiary(false);
  }, [selectedKey, diaryByDate]);

  const saveDiary = () => {
    const value = diaryDraft.trim();
    setDiaryByDate((all) => {
      if (!value) {
        const next = { ...all };
        delete next[selectedKey];
        return next;
      }
      return { ...all, [selectedKey]: value };
    });
    setEditingDiary(false);
  };

  const firstWeekday = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1).getDay();
  const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
  const calendarCells = Array.from({ length: 42 }, (_, index) => index - firstWeekday + 1);
  const formattedDate = selectedDate.toLocaleDateString("en-US", { month: "long", day: "numeric", weekday: "long" });
  const isToday = selectedKey === todayKey;

  return (
    <main className="page diary-page">
      <header className="section-title">
        <h1>Diary</h1>
        <span className="book-mark">▣</span>
      </header>

      <div className="segmented-control">
        <button className={mode === "mine" ? "active" : ""} onClick={() => setMode("mine")}>{profile.userName || "user"}</button>
        <button className={mode === "rune" ? "active" : ""} onClick={() => setMode("rune")}>{profile.name || "Rune"}</button>
      </div>

      <p className="date-label">{formattedDate}</p>

      <section className="glass-card todo-card">
        <div className="section-heading">
          <h2>{isToday ? "Today's To Do" : "To Do"}</h2>
          <span>{pending} left ›</span>
        </div>
        <div className="todo-list">
          {!todos.length && <p className="empty-todos">这一天还没有待办。</p>}
          {todos.map((todo) => (
            <button key={todo.id} className={todo.done ? "todo done" : "todo"} onClick={() => toggleTodo(todo.id)}>
              <i>{todo.done ? "✓" : ""}</i>
              <span><strong>{todo.text}</strong><small>{todo.meta}</small></span>
              <em>{todo.done ? "完成" : "待办"}</em>
            </button>
          ))}
        </div>
        <div className="quick-add">
          <input value={newTodo} onChange={(event) => setNewTodo(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addTodo()} placeholder={`添加 ${selectedDate.getMonth() + 1} 月 ${selectedDate.getDate()} 日的待办…`} />
          <button onClick={addTodo} aria-label="添加待办">＋</button>
        </div>
      </section>

      <section className="glass-card week-strip">
        {Array.from({ length: 7 }, (_, index) => {
          const date = new Date(selectedDate);
          date.setDate(selectedDate.getDate() - selectedDate.getDay() + index);
          const key = localDateKey(date);
          return <button className={key === selectedKey ? "today" : ""} key={key} onClick={() => setSelectedDate(date)}><span>{["日", "一", "二", "三", "四", "五", "六"][index]}</span><strong>{date.getDate()}</strong></button>;
        })}
      </section>

      <article className="journal-entry">
        <div className="entry-meta-row">
          <p className="entry-meta"><span>◉</span> {formattedDate} {isToday && <b>今天</b>}</p>
          {mode === "mine" && !editingDiary && <button onClick={() => setEditingDiary(true)}>{diaryByDate[selectedKey] ? "编辑" : "写日记"}</button>}
        </div>
        {mode === "mine" && editingDiary ? (
          <div className="diary-editor">
            <textarea autoFocus value={diaryDraft} onChange={(event) => setDiaryDraft(event.target.value)} placeholder="写下这一天发生的事、心情或想记住的话……" />
            <div>
              <button className="text-action" onClick={() => { setDiaryDraft(diaryByDate[selectedKey] || ""); setEditingDiary(false); }}>取消</button>
              <button className="save-diary" onClick={saveDiary}>保存日记</button>
            </div>
          </div>
        ) : (
          <p className={!(mode === "mine" ? diaryByDate[selectedKey] : runeDiaryByDate[selectedKey]) ? "empty-entry" : ""}>
            {mode === "mine"
              ? diaryByDate[selectedKey] || "这一天还没有写日记。"
              : runeDiaryByDate[selectedKey] || `${profile.name || "Rune"} 这一天还没有写日记。`}
          </p>
        )}
      </article>

      <section className="calendar-card glass-card">
        <div className="calendar-head">
          <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}>‹</button>
          <strong>{calendarMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</strong>
          <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}>›</button>
        </div>
        <div className="calendar-grid">
          {["S","M","T","W","T","F","S"].map((d, i) => <span key={`${d}-${i}`} className="weekday">{d}</span>)}
          {calendarCells.map((day, index) => {
            if (day < 1 || day > daysInMonth) return <span key={index} className="empty" />;
            const date = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day);
            const key = localDateKey(date);
            const hasTodos = Boolean(todosByDate[key]?.length);
            return <button key={key} className={`${key === selectedKey ? "selected-day" : ""} ${hasTodos ? "has-todos" : ""}`} onClick={() => setSelectedDate(date)}>{day}</button>;
          })}
        </div>
      </section>
    </main>
  );
}

function ChatView({
  aiApiBase,
  claudeKey,
  claudeModel,
  claudeModels,
  setClaudeModel,
  goSettings,
  mcpServers,
  setHomeMessage,
  profile,
  voiceConfig,
  minimaxKey,
}: {
  aiApiBase: string;
  voiceConfig: VoiceConfig;
  minimaxKey: string;
  claudeKey: string;
  claudeModel: string;
  claudeModels: ClaudeModel[];
  setClaudeModel: (model: string) => void;
  goSettings: () => void;
  mcpServers: McpServer[];
  setHomeMessage: (message: string) => void;
  profile: Profile;
}) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [chatNotice, setChatNotice] = useState("");
  const [actions, setActions] = useState<RuneAction[]>([]);
  const [conversations, setConversations] = useState<StoredConversation[]>([]);
  const [activeId, setActiveId] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const hydrated = useRef(false);
  const attachmentRef = useRef<HTMLInputElement>(null);
  const messageStreamRef = useRef<HTMLElement>(null);

  // ── 语音 ───────────────────────────────────────────────
  const [listening, setListening] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const [preparingIndex, setPreparingIndex] = useState<number | null>(null);
  const [clips, setClips] = useState<Record<number, VoiceClip>>({});
  const [shownText, setShownText] = useState<Record<number, boolean>>({});
  const clipsRef = useRef<Record<number, VoiceClip>>({});
  const [callActive, setCallActive] = useState(false);
  const [callStage, setCallStage] = useState<"idle" | "listening" | "thinking" | "speaking">("idle");
  const [callReply, setCallReply] = useState("");
  const orbRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const callActiveRef = useRef(false);
  const mcpSessionsRef = useRef<Record<number, { sessionId?: string; tools: McpTool[] }>>({});
  const voiceReady = Boolean(minimaxKey && voiceConfig.voiceId);

  const connectMcpServer = async (server: McpServer) => {
    const cached = mcpSessionsRef.current[server.id];
    if (cached) return cached;
    const initialized = await callMcpRpc(server, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "Rune", version: "1.0" },
    });
    await notifyMcpInitialized(server, initialized.sessionId);
    const listed = await callMcpRpc(server, "tools/list", {}, initialized.sessionId);
    const connection = { sessionId: listed.sessionId, tools: (listed.result?.tools || []) as McpTool[] };
    mcpSessionsRef.current[server.id] = connection;
    return connection;
  };

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const stream = messageStreamRef.current;
    if (!stream) return;
    stream.scrollTo({ top: stream.scrollHeight, behavior: messages.length > 1 ? "smooth" : "auto" });
  }, [messages, sending]);

  useEffect(() => {
    if (typeof globalThis.location === "undefined") return;
    if (new URLSearchParams(globalThis.location.search).get("preview") !== "voice-call") return;
    setCallActive(true);
    callActiveRef.current = true;
    setCallStage("speaking");
    setCallReply("我在。慢慢说，我会听着。 ");
  }, []);

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      if (audioRef.current.src.startsWith("blob:")) URL.revokeObjectURL(audioRef.current.src);
      audioRef.current = null;
    }
    setSpeakingIndex(null);
  };

  // 朗读一段文字，返回一个在播放结束时 resolve 的 Promise（通话模式要靠它串起来）
  const speak = async (text: string, index: number | null) => {
    stopAudio();
    const url = await synthesizeSpeech(text, voiceConfig, minimaxKey);
    const audio = new Audio(url);
    audioRef.current = audio;
    setSpeakingIndex(index);
    await new Promise<void>((resolve) => {
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
      audio.play().catch(() => resolve());
    });
    if (audioRef.current === audio) audioRef.current = null;
    setSpeakingIndex(null);
  };

  // 语音消息：合成一次后缓存，之后点开即播；顺便拿到真实时长用来显示
  const prepareClip = async (index: number, text: string): Promise<VoiceClip | null> => {
    const existing = clipsRef.current[index];
    if (existing) return existing;
    setPreparingIndex(index);
    try {
      const url = await synthesizeSpeech(text, voiceConfig, minimaxKey);
      const duration = await new Promise<number>((resolve) => {
        const probe = new Audio(url);
        probe.onloadedmetadata = () => resolve(Number.isFinite(probe.duration) ? probe.duration : 0);
        probe.onerror = () => resolve(0);
      });
      const clip: VoiceClip = { url, duration };
      clipsRef.current[index] = clip;
      setClips({ ...clipsRef.current });
      return clip;
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "语音合成失败。");
      globalThis.setTimeout(() => setChatNotice(""), 3500);
      return null;
    } finally {
      setPreparingIndex(null);
    }
  };

  const playClip = (index: number, url: string) => {
    stopAudio();
    const audio = new Audio(url);
    audioRef.current = audio;
    setSpeakingIndex(index);
    audio.onended = () => { if (audioRef.current === audio) audioRef.current = null; setSpeakingIndex(null); };
    audio.onerror = () => { setSpeakingIndex(null); };
    audio.play().catch(() => setSpeakingIndex(null));
  };

  const toggleVoiceMessage = async (index: number, text: string) => {
    if (speakingIndex === index) { stopAudio(); return; }
    const clip = clipsRef.current[index] || await prepareClip(index, text);
    if (clip) playClip(index, clip.url);
  };

  // 听一句话：静音或用户手动停止后 resolve 出最终文本
  const listenOnce = () => new Promise<string>((resolve, reject) => {
    const Recognition = speechRecognitionClass();
    if (!Recognition) { reject(new Error("当前页面没有拿到系统语音识别接口。请确认使用 HTTPS，并在 iPhone 设置中允许 Rune 使用麦克风与语音识别。")); return; }
    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognitionRef.current = recognition;
    let finalText = "";
    let settled = false;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      resolve(text.trim());
    };
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript || "";
        if (result.isFinal) finalText += text; else interim += text;
      }
      setLiveTranscript(finalText + interim);
    };
    recognition.onerror = (event) => {
      recognitionRef.current = null;
      setListening(false);
      if (event.error === "no-speech" || event.error === "aborted") { finish(finalText); return; }
      settled = true;
      reject(new Error(event.error === "not-allowed" ? "麦克风权限被拒绝了。" : `语音识别出错：${event.error}`));
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      finish(finalText);
    };
    setListening(true);
    setLiveTranscript("");
    try {
      recognition.start();
    } catch (error) {
      recognitionRef.current = null;
      setListening(false);
      settled = true;
      reject(error instanceof Error ? error : new Error("语音识别启动失败。"));
    }
  });

  const stopListening = () => {
    recognitionRef.current?.stop();
    setListening(false);
  };

  // 发一条语音消息：录 → 转文字 → 当普通消息发出去
  const sendVoiceMessage = async () => {
    if (listening) { stopListening(); return; }
    try {
      const text = await listenOnce();
      setLiveTranscript("");
      if (!text) { setChatNotice("没听清，再说一次？"); globalThis.setTimeout(() => setChatNotice(""), 2500); return; }
      await sendMessage(text);
    } catch (error) {
      setChatNotice(error instanceof Error ? error.message : "录音失败。");
      globalThis.setTimeout(() => setChatNotice(""), 3500);
    }
  };

  // 通话模式：听 → 发 → 朗读 → 再听，循环到挂断
  const runCall = async () => {
    let retryCount = 0;
    while (callActiveRef.current) {
      try {
        setCallStage("listening");
        setCallReply("");
        const said = await listenOnce();
        if (!callActiveRef.current) break;
        setLiveTranscript("");
        if (!said) {
          await new Promise((resolve) => globalThis.setTimeout(resolve, 350));
          continue;
        }
        retryCount = 0;
        setChatNotice("");

        setCallStage("thinking");
        const reply = await sendMessage(said);
        if (!callActiveRef.current) break;

        if (reply) {
          setCallReply(reply);      // 文字和语音同时出来
          setCallStage("speaking");
          await speak(reply, null);
          // iPhone 需要一点时间释放扬声器音频会话，再重新占用麦克风。
          if (callActiveRef.current) await new Promise((resolve) => globalThis.setTimeout(resolve, 550));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "语音识别暂时中断。";
        if (/权限|not-allowed|denied|HTTPS/i.test(message)) {
          setChatNotice(message);
          break;
        }
        retryCount += 1;
        setChatNotice(`语音识别暂时中断，正在重试（${retryCount}）…`);
        await new Promise((resolve) => globalThis.setTimeout(resolve, Math.min(1800, 500 + retryCount * 250)));
      }
    }
    setCallStage("idle");
    setCallActive(false);
    callActiveRef.current = false;
  };

  const startCall = () => {
    if (!voiceReady) { setChatNotice("先去 Settings → 语音 填好 MiniMax 的 Key 和 Voice ID。"); return; }
    setCallActive(true);
    callActiveRef.current = true;
    setShowHistory(false);
    runCall();
  };

  const endCall = () => {
    callActiveRef.current = false;
    setCallActive(false);
    setCallStage("idle");
    setCallReply("");
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    stopAudio();
    setLiveTranscript("");
  };

  // 每帧逐根算高度。CSS 动画做不到这个效果：给每根线加固定相位差，
  // 得到的永远是"形状固定的波在绕圈跑"，看起来就是个不规则轮廓在原地转。
  // 这里用四个正弦叠加，角度频率(3/7/11/5)和时间频率(1.7/-2.3/3.1/-1.1)
  // 都互不成比例，所以波形本身在不断改变，而不只是旋转。
  useEffect(() => {
    const wave = waveRef.current;
    if (!wave) return;
    const bars = Array.from(wave.querySelectorAll<HTMLElement>("b"));
    if (!bars.length) return;

    if (callStage !== "speaking") {
      for (const bar of bars) bar.style.transform = "scaleY(1)";
      orbRef.current?.style.setProperty("--level", "0");
      return;
    }

    const count = bars.length;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = (now - start) / 1000;
      let peak = 0;
      for (let i = 0; i < count; i += 1) {
        const angle = (i / count) * Math.PI * 2;
        const value =
          0.50 * Math.sin(angle * 3 + t * 1.7) +
          0.30 * Math.sin(angle * 7 - t * 2.3) +
          0.20 * Math.sin(angle * 11 + t * 3.1) +
          0.15 * Math.sin(angle * 5 - t * 1.1);
        const scale = 0.5 + (value + 1.15) / 2.3 * 1.4;   // 归一化到约 0.5–1.9
        bars[i].style.transform = `scaleY(${scale.toFixed(3)})`;
        if (scale > peak) peak = scale;
      }
      orbRef.current?.style.setProperty("--level", Math.min(1, (peak - 0.5) / 1.4).toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [callStage]);

  // 离开页面时把麦克风和音频都收干净
  useEffect(() => () => {
    callActiveRef.current = false;
    recognitionRef.current?.abort();
    if (audioRef.current) audioRef.current.pause();
  }, []);

  const selectedModel = claudeModels.find((model) => model.id === claudeModel);

  useEffect(() => {
    if (typeof globalThis.document === "undefined") return;
    try {
      const stored = JSON.parse(localStorage.getItem(CHAT_HISTORY_KEY) || "[]") as StoredConversation[];
      if (Array.isArray(stored)) setConversations(stored);
    } catch {
      // 存储损坏就当没有历史，不影响使用
    }
    setActiveId(Date.now());
    hydrated.current = true;
  }, []);

  // 当前对话每次变动都写回历史，切走或刷新都不会丢。
  useEffect(() => {
    if (!hydrated.current || !activeId || !messages.length) return;
    setConversations((previous) => {
      const existing = previous.find((c) => c.id === activeId);
      const snapshot = messages;
      // 只是把旧对话读出来查看时，内容没有任何变化，不能因此把它标记成"刚更新"
      // 或重算标题——否则打开一次历史就会把它的名字和时间改掉。
      if (existing && JSON.stringify(existing.messages) === JSON.stringify(snapshot)) return previous;
      const entry: StoredConversation = {
        id: activeId,
        title: existing?.title || conversationTitle(messages),
        updatedAt: Date.now(),
        messages: snapshot,
      };
      const rest = previous.filter((c) => c.id !== activeId);
      return [entry, ...rest].slice(0, MAX_CONVERSATIONS);
    });
  }, [messages, activeId]);

  useEffect(() => {
    if (!hydrated.current) return;
    const { saved, dropped } = persistConversations(conversations);
    if (dropped > 0) {
      // 已经淘汰掉的对话不能留在内存里，否则下次又会试着写一遍
      setConversations(saved);
      setChatNotice(`存储快满了，已清掉 ${dropped} 段最旧的对话。`);
      globalThis.setTimeout(() => setChatNotice(""), 3000);
    }
  }, [conversations]);

  const openConversation = (id: number) => {
    const target = conversations.find((c) => c.id === id);
    if (!target) return;
    setActiveId(id);
    setMessages(target.messages);
    setActions([]);
    setAttachments([]);
    setInput("");
    setShowHistory(false);
  };

  const deleteConversation = (id: number) => {
    setConversations((previous) => previous.filter((c) => c.id !== id));
    if (id === activeId) {
      setMessages([]);
      setActions([]);
      setActiveId(Date.now());
    }
  };

  const addAttachments = async (files?: FileList | null) => {
    if (!files?.length) return;
    const accepted: ChatAttachment[] = [];
    for (const file of Array.from(files)) {
      if (file.size > 5 * 1024 * 1024) {
        setChatNotice(`${file.name} 超过 5MB，暂时不能添加。`);
        continue;
      }
      if (file.type.startsWith("image/")) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        accepted.push({ id: Date.now() + accepted.length, name: file.name, kind: "image", mediaType: file.type, data: dataUrl.split(",")[1] || "" });
      } else {
        accepted.push({ id: Date.now() + accepted.length, name: file.name, kind: "text", mediaType: file.type || "text/plain", data: await file.text() });
      }
    }
    setAttachments((current) => [...current, ...accepted].slice(0, 5));
    if (accepted.length) setChatNotice(`已添加 ${accepted.length} 个附件。`);
    if (attachmentRef.current) attachmentRef.current.value = "";
  };

  const startNewChat = () => {
    // 当前对话已经由上面的 effect 存进历史了，这里只需换一个新 id
    setMessages([]);
    setInput("");
    setAttachments([]);
    setActions([]);
    setActiveId(Date.now());
    setShowHistory(false);
    setChatNotice("已开启新对话");
    globalThis.setTimeout(() => setChatNotice(""), 1800);
  };

  const applyRuneAction = async (action: RuneAction) => {
    const date = action.input.date || localDateKey(new Date());
    if (action.name === "add_todo") {
      const all = JSON.parse(localStorage.getItem("pulse-diary-todos") || "{}") as Record<string, Todo[]>;
      all[date] = [...(all[date] || []), { id: Date.now(), text: action.input.text || "新的待办", meta: date, done: false }];
      localStorage.setItem("pulse-diary-todos", JSON.stringify(all));
    }
    if (action.name === "write_diary") {
      const storageKey = action.input.owner === "rune" ? "pulse-rune-diary-entries" : "pulse-diary-entries";
      const all = JSON.parse(localStorage.getItem(storageKey) || "{}") as Record<string, string>;
      all[date] = action.input.content || "";
      localStorage.setItem(storageKey, JSON.stringify(all));
    }
    if (action.name === "set_home_message") setHomeMessage(action.input.message || "今天也辛苦了。");
    if (action.name === "create_reminder") {
      const reminders = JSON.parse(localStorage.getItem("rune-reminders") || "[]") as Array<Record<string, string>>;
      reminders.push({ id: String(Date.now()), title: action.input.title || "Rune 提醒", datetime: action.input.datetime || "" });
      localStorage.setItem("rune-reminders", JSON.stringify(reminders));
      const { deviceId, deviceToken } = await ensureRuneDevice();
      if (deviceId && deviceToken) {
        const response = await fetch(`${runeApiBase()}/api/reminders`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-rune-device": deviceId, "x-rune-token": deviceToken },
          body: JSON.stringify({ title: action.input.title || "提醒", content: action.input.content || action.input.title || "你有一个新的提醒。", scheduledAt: action.input.datetime, runeName: profile.name || "Rune", runeAvatar: profile.avatar || "", barkServer: localStorage.getItem("rune-bark-server") || "", barkKey: localStorage.getItem("rune-bark-key") || "" }),
        });
        if (!response.ok) throw new Error(`提醒已保存在本机，但后台同步失败（HTTP ${response.status}）。`);
      }
    }
    setActions((items) => items.map((item) => item.id === action.id ? { ...item, status: "done" } : item));
    setMessages((items) => [...items, { role: "assistant", text: `${action.name === "add_todo" ? "待办" : action.name === "write_diary" ? "日记" : action.name === "set_home_message" ? "首页文字" : "提醒"}已经更新。` }]);
  };

  const sendMessage = async (spokenText?: string): Promise<string> => {
    const raw = (spokenText ?? input).trim();
    const text = raw;
    if ((!text && !attachments.length) || sending) return "";
    const outgoingAttachments = attachments;
    const nextMessages: ChatMessage[] = [...messagesRef.current, { role: "user", text, attachments: outgoingAttachments }];
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    setInput("");
    setAttachments([]);
    if (!claudeKey || !claudeModel) {
      const hint = "先去 Settings 连接 AI API 并选择模型，我就可以真正回复你了。";
      messagesRef.current = [...nextMessages, { role: "assistant", text: hint }];
      setMessages(messagesRef.current);
      return hint;
    }

    setSending(true);
    try {
      const enabledMcp = mcpServers.filter((server) => server.enabled && /^https:\/\//.test(server.url));
      const runeTools = [
        { name: "add_todo", description: "在 Rune Diary 的指定日期添加待办。任何写入都必须先向用户展示确认。", input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" }, text: { type: "string" } }, required: ["date", "text"] } },
        { name: "write_diary", description: "在 Rune Diary 写日记。必须判断是在写用户自己的日记，还是 Rune/Agent 第一人称的日记，并通过 owner 区分。任何写入都必须先确认。", input_schema: { type: "object", properties: { owner: { type: "string", enum: ["user", "rune"], description: "user=用户的日记；rune=Rune/Agent 的日记" }, date: { type: "string", description: "YYYY-MM-DD" }, content: { type: "string" } }, required: ["owner", "date", "content"] } },
        { name: "set_home_message", description: "修改 Rune 首页顶部的主要问候文字。", input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
        { name: "create_reminder", description: "创建 Rune 定时提醒。根据对话语气自行编辑简洁自然的通知标题与正文。", input_schema: { type: "object", properties: { title: { type: "string", description: "简短通知标题" }, content: { type: "string", description: "由你编辑的通知正文" }, datetime: { type: "string", description: "带时区的 ISO 8601 时间" } }, required: ["title", "content", "datetime"] } },
      ];
      const apiBase = normalizeAiApiBase(aiApiBase);
      const protocol = apiProtocolFor(apiBase);
      const mcpToolMap = new Map<string, { server: McpServer; tool: McpTool; sessionId?: string }>();
      if (protocol === "openai") {
        for (const server of enabledMcp) {
          try {
            const connection = await connectMcpServer(server);
            for (const tool of connection.tools) {
              const safeName = `mcp_${server.id}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
              mcpToolMap.set(safeName, { server, tool, sessionId: connection.sessionId });
            }
          } catch (error) {
            setChatNotice(`${server.name} MCP 连接失败：${error instanceof Error ? error.message : "请检查地址、授权和 CORS"}`);
          }
        }
      }
      const systemPrompt = `${profile.instructions || defaultProfile.instructions}\n\n${nowContext()}\n需要修改 ${profile.name || "Rune"} 数据或创建提醒时必须调用对应工具，不要假装已经完成。
${voiceReady ? "当这句话情绪比较浓、更适合说出来而不是打字时（安慰、想念、认真的鼓励、道歉之类），在回复最前面加上 [[voice]] 标记，它会以语音消息的形式发过去。日常闲聊、查信息、确认事项不要加。一次对话里别频繁使用。" : ""}`;
      const endpoint = protocol === "anthropic" ? `${apiBase}/messages` : `${apiBase}/chat/completions`;
      const openAiMessages = [
        { role: "system", content: systemPrompt },
        ...nextMessages.map((message) => ({ role: message.role, content: message.text || "（含附件的消息）" })),
      ];
      const openAiTools = [
        ...runeTools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
        ...Array.from(mcpToolMap.entries()).map(([name, item]) => ({
          type: "function",
          function: { name, description: `[${item.server.name} MCP] ${item.tool.description || item.tool.name}`, parameters: item.tool.inputSchema || { type: "object", properties: {} } },
        })),
      ];
      const response = await fetch(endpoint, {
        method: "POST",
        headers: protocol === "anthropic" ? {
          "content-type": "application/json", "x-api-key": claudeKey,
          "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true",
          ...(enabledMcp.length ? { "anthropic-beta": "mcp-client-2025-04-04" } : {}),
        } : { "content-type": "application/json", authorization: `Bearer ${claudeKey}` },
        body: JSON.stringify(protocol === "anthropic" ? {
          model: claudeModel,
          max_tokens: 2048,
          system: systemPrompt,
          messages: nextMessages.map((message) => ({
            role: message.role,
            content: message.role === "assistant" ? message.text : [
              // 历史记录在存储吃紧时可能把附件内容清空，只剩文件名。
              // 这种情况下不能把空数据发给 API（会直接报错），改成一句说明。
              ...(message.attachments || []).map((attachment) => !attachment.data
                ? { type: "text", text: `（附件「${attachment.name}」的内容未保留在历史记录中）` }
                : attachment.kind === "image"
                  ? { type: "image", source: { type: "base64", media_type: attachment.mediaType, data: attachment.data } }
                  : { type: "text", text: `附件「${attachment.name}」内容：\n${attachment.data}` }),
              ...(message.text ? [{ type: "text", text: message.text }] : []),
            ],
          })),
          tools: [
            ...runeTools,
            ...enabledMcp.map((server) => ({ type: "mcp_toolset", mcp_server_name: server.name })),
          ],
          ...(enabledMcp.length ? { mcp_servers: enabledMcp.map((server) => ({ type: "url", url: server.url, name: server.name, ...(server.token ? { authorization_token: server.token } : {}) })) } : {}),
        } : {
          model: claudeModel,
          max_tokens: 2048,
          messages: openAiMessages,
          tools: openAiTools,
        }),
      });
      let data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || "AI API 请求失败");
      const usage: TokenUsage = protocol === "anthropic"
        ? { input: Number(data.usage?.input_tokens || 0), output: Number(data.usage?.output_tokens || 0), total: Number(data.usage?.input_tokens || 0) + Number(data.usage?.output_tokens || 0) }
        : { input: Number(data.usage?.prompt_tokens || 0), output: Number(data.usage?.completion_tokens || 0), total: Number(data.usage?.total_tokens || 0) };
      const toolTraces: ToolTrace[] = [];
      let reasoning = "";
      if (protocol === "openai") {
        const assistantMessage = data.choices?.[0]?.message;
        reasoning = String(assistantMessage?.reasoning_content || assistantMessage?.reasoning || "").trim();
        const externalCalls = (assistantMessage?.tool_calls || []).filter((call: { function?: { name?: string } }) => mcpToolMap.has(call.function?.name || ""));
        if (externalCalls.length) {
          const toolResults = [];
          for (const call of externalCalls) {
            const mapped = mcpToolMap.get(call.function.name)!;
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
            try {
              const called = await callMcpRpc(mapped.server, "tools/call", { name: mapped.tool.name, arguments: args }, mapped.sessionId);
              toolResults.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(called.result ?? {}) });
              toolTraces.push({ name: mapped.tool.name, server: mapped.server.name, input: args, output: called.result ?? {}, status: "完成" });
            } catch (error) {
              const message = error instanceof Error ? error.message : "MCP 调用失败";
              toolResults.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: message }) });
              toolTraces.push({ name: mapped.tool.name, server: mapped.server.name, input: args, output: message, status: "失败" });
            }
          }
          const followup = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${claudeKey}` },
            body: JSON.stringify({ model: claudeModel, max_tokens: 2048, messages: [...openAiMessages, assistantMessage, ...toolResults], tools: openAiTools }),
          });
          data = await followup.json();
          if (!followup.ok) throw new Error(data?.error?.message || "MCP 结果回传模型失败");
          usage.input += Number(data.usage?.prompt_tokens || 0);
          usage.output += Number(data.usage?.completion_tokens || 0);
          usage.total = usage.input + usage.output;
          const followupMessage = data.choices?.[0]?.message;
          reasoning = String(followupMessage?.reasoning_content || followupMessage?.reasoning || reasoning).trim();
        }
      } else {
        reasoning = (data.content || []).filter((block: { type?: string }) => block.type === "thinking" || block.type === "reasoning").map((block: { thinking?: string; text?: string; summary?: string }) => block.thinking || block.summary || block.text || "").filter(Boolean).join("\n").trim();
        for (const block of (data.content || [])) {
          if (block.type === "mcp_tool_use") toolTraces.push({ name: String(block.name || "MCP tool"), server: String(block.server_name || "MCP"), input: block.input, status: "完成" });
          if (block.type === "mcp_tool_result") {
            const trace = [...toolTraces].reverse().find((item) => item.output === undefined);
            if (trace) trace.output = block.content;
          }
        }
      }
      const reply = protocol === "anthropic"
        ? (data.content || []).filter((block: { type: string }) => block.type === "text").map((block: { text: string }) => block.text).join("\n")
        : String(data.choices?.[0]?.message?.content || "");
      const proposed = protocol === "anthropic"
        ? (data.content || []).filter((block: { type: string; name?: string }) => block.type === "tool_use" && ["add_todo", "write_diary", "set_home_message", "create_reminder"].includes(block.name || "")).map((block: { id: string; name: RuneAction["name"]; input: Record<string, string> }) => ({ id: block.id, name: block.name, input: block.input, status: "pending" as const }))
        : (data.choices?.[0]?.message?.tool_calls || []).filter((call: { function?: { name?: string } }) => ["add_todo", "write_diary", "set_home_message", "create_reminder"].includes(call.function?.name || "")).map((call: { id: string; function: { name: RuneAction["name"]; arguments?: string } }) => {
            let input: Record<string, string> = {};
            try { input = JSON.parse(call.function.arguments || "{}"); } catch { input = {}; }
            return { id: call.id, name: call.function.name, input, status: "pending" as const };
          });
      for (const action of proposed) toolTraces.push({ name: action.name, server: "Rune", input: action.input, status: "等待确认" });
      // Rune 用 [[voice]] 标记"这句想说出来"，剥掉标记并记成语音消息
      const wantsVoice = VOICE_MARK.test(reply);
      const spoken = reply.replace(VOICE_MARK, "").trim();
      const finalReply = spoken || reply || (proposed.length ? "我准备执行下面的操作，请你确认。" : "我在。");
      const replyIndex = nextMessages.length;
      messagesRef.current = [...nextMessages, { role: "assistant", text: finalReply, voice: wantsVoice && voiceReady, reasoning: reasoning || undefined, toolTraces: toolTraces.length ? toolTraces : undefined, usage: usage.total ? usage : undefined }];
      setMessages(messagesRef.current);
      // 首页那张卡片跟着对话走：每次回复都同步过去，附带时间戳。
      if (finalReply) setHomeMessage(finalReply);
      if (proposed.length) setActions((items) => [...items, ...proposed]);
      // 语音消息先合成好，点开就能响；通话模式由 runCall 自己念，这里不重复
      if (wantsVoice && voiceReady && !callActiveRef.current) {
        prepareClip(replyIndex, finalReply)
          .then((clip) => { if (voiceConfig.autoPlay && clip) playClip(replyIndex, clip.url); })
          .catch(() => undefined);
      }
      return finalReply;
    } catch (error) {
      const failure = `连接失败：${error instanceof Error ? error.message : "请检查 API Key 和网络。"}`;
      messagesRef.current = [...nextMessages, { role: "assistant", text: failure }];
      setMessages(messagesRef.current);
      return failure;
    } finally {
      setSending(false);
    }
  };

  const callLabel = { idle: "接通中…", listening: "在听你说", thinking: "正在想", speaking: `${profile.name || "Rune"} 在说` }[callStage];

  return (
    <main className="page claude-chat-page">
      {callActive && (
        <div className="call-overlay" role="dialog" aria-label="语音通话">
          <div className={`call-orb ${callStage}`} ref={orbRef}>
            <div className="call-halo" aria-hidden="true" />
            <div className="call-wave" aria-hidden="true" ref={waveRef}>
              {Array.from({ length: 180 }, (_, i) => (
                <i key={i} style={{ "--i": i } as React.CSSProperties}><b /></i>
              ))}
            </div>
            <div className="call-avatar">
              {profile.avatar ? <img src={profile.avatar} alt="" /> : <span>{initialOf(profile.name, "R")}</span>}
            </div>
          </div>
          <strong>{profile.name || "Rune"}</strong>
          <p className={`call-stage ${callStage}`}>{callLabel}</p>
          {/* 说话时把回复文字一起显示出来，听的时候显示实时字幕 */}
          <p className={callStage === "speaking" ? "call-transcript reply" : "call-transcript"}>
            {callStage === "speaking"
              ? callReply
              : liveTranscript || (callStage === "listening" ? "说点什么…" : "")}
          </p>
          <button className="call-end" onClick={endCall} aria-label="挂断">挂断</button>
        </div>
      )}

      <header className="claude-chat-header">
        <span className="claude-mini-mark">{profile.avatar ? <img src={profile.avatar} alt="" /> : <img src="./pulse-icon-claude.png" alt="" />}</span>
        <div><strong>{profile.name || "Rune"}</strong></div>
        {(
          <button className="voice-call-button call-button" onClick={startCall} aria-label={`和 ${profile.name || "Rune"} 语音通话`} title="语音通话"><PhoneIcon /></button>
        )}
        <button
          className={showHistory ? "history-button active" : "history-button"}
          onClick={() => setShowHistory((open) => !open)}
          aria-label="历史对话"
          aria-expanded={showHistory}
        >☰</button>
        <button onClick={startNewChat} aria-label="新对话">＋</button>
      </header>
      {chatNotice && <div className="chat-notice" role="status">{chatNotice}</div>}

      {showHistory && (
        <section className="chat-history" aria-label="历史对话">
          {!conversations.length && <p className="history-empty">还没有历史对话。聊过之后会自动存在这里。</p>}
          {conversations.map((conversation) => (
            <div className={conversation.id === activeId ? "history-row current" : "history-row"} key={conversation.id}>
              <button className="history-open" onClick={() => openConversation(conversation.id)}>
                <strong>{conversation.title}</strong>
                <small>{conversationTime(conversation.updatedAt)} · {conversation.messages.length} 条</small>
              </button>
              <button className="history-delete" aria-label={`删除 ${conversation.title}`} onClick={() => deleteConversation(conversation.id)}>×</button>
            </div>
          ))}
        </section>
      )}

      <section ref={messageStreamRef} className={messages.length ? "claude-message-stream" : "claude-message-stream empty"} aria-label={`与 ${profile.name || "Rune"} 的对话`}>
        {!messages.length && (
          <div className="claude-welcome">
            {profile.avatar ? <img className="welcome-avatar" src={profile.avatar} alt="" /> : <img src="./pulse-icon-claude.png" alt="" />}
            <h1>今天想聊些什么？</h1>
            <p>{claudeKey ? `${profile.name || "Rune"} 已经准备好了。` : "连接 AI API 后，这里会变成真正的对话。"}</p>
            {!claudeKey && <button onClick={goSettings}>前往 Settings</button>}
          </div>
        )}
        {messages.map((message, index) => (
          <article className={`claude-message ${message.role}`} key={`${message.role}-${index}`}>
            <span className="msg-avatar" aria-hidden="true">
              {message.role === "assistant"
                ? (profile.avatar ? <img src={profile.avatar} alt="" /> : initialOf(profile.name, "R"))
                : (profile.userAvatar ? <img src={profile.userAvatar} alt="" /> : initialOf(profile.userName, "我"))}
            </span>
            <div>
              {/* 自己发的消息不显示昵称，头像已经足够区分 */}
              {message.role === "assistant" && <span className="msg-name">{profile.name || "Rune"}</span>}
              {!!message.attachments?.length && <div className="sent-attachments">{message.attachments.map((attachment) => <span key={attachment.id}>{attachment.kind === "image" ? "▧" : "≡"} {attachment.name}</span>)}</div>}
              {message.voice ? (
                <div className="voice-message">
                  <button
                    className={speakingIndex === index ? "voice-bubble playing" : "voice-bubble"}
                    onClick={() => toggleVoiceMessage(index, message.text)}
                    aria-label={speakingIndex === index ? "停止播放" : "播放语音"}
                  >
                    <span className="voice-icon">{preparingIndex === index ? "…" : speakingIndex === index ? "◼" : "▶"}</span>
                    <span className="voice-wave" aria-hidden="true">
                      {[7, 13, 9, 16, 11, 6, 14, 10].map((h, i) => <i key={i} style={{ height: h }} />)}
                    </span>
                    <small>{clips[index]?.duration ? `${Math.max(1, Math.round(clips[index].duration))}"` : "语音"}</small>
                  </button>
                  <button className="voice-to-text" onClick={() => setShownText((m) => ({ ...m, [index]: !m[index] }))}>
                    {shownText[index] ? "收起文字" : "转文字"}
                  </button>
                  {shownText[index] && <p className="voice-transcript">{message.text}</p>}
                </div>
              ) : (
                message.text && <p>{message.text}</p>
              )}
              {message.role === "assistant" && (!!message.reasoning || !!message.toolTraces?.length) && (
                <details className="message-trace">
                  <summary>{message.reasoning ? "思考摘要" : "工具调用"}{message.toolTraces?.length ? ` · ${message.toolTraces.length} 条` : ""}</summary>
                  {message.reasoning && <section><b>模型返回的思考摘要</b><p>{message.reasoning}</p></section>}
                  {message.toolTraces?.map((trace, traceIndex) => (
                    <section className="tool-trace" key={`${trace.name}-${traceIndex}`}>
                      <b>{trace.server ? `${trace.server} · ` : ""}{trace.name}<em>{trace.status}</em></b>
                      {trace.input !== undefined && <pre>参数\n{JSON.stringify(trace.input, null, 2)}</pre>}
                      {trace.output !== undefined && <pre>结果\n{typeof trace.output === "string" ? trace.output : JSON.stringify(trace.output, null, 2)}</pre>}
                    </section>
                  ))}
                </details>
              )}
              {message.role === "assistant" && message.usage && (
                <small className="message-usage">{message.usage.total.toLocaleString()} tokens</small>
              )}
            </div>
          </article>
        ))}
        {sending && (
          <article className="claude-message assistant thinking">
            <span className="msg-avatar" aria-hidden="true">
              {profile.avatar ? <img src={profile.avatar} alt="" /> : initialOf(profile.name, "R")}
            </span>
            <div><span className="msg-name">{profile.name || "Rune"}</span><p>正在思考<span>•••</span></p></div>
          </article>
        )}
        {actions.map((action) => (
          <article className={`action-confirm-card ${action.status}`} key={action.id}>
            <p className="eyebrow">Rune action</p>
            <strong>{action.name === "add_todo" ? "添加待办" : action.name === "write_diary" ? "写入日记" : action.name === "set_home_message" ? "修改首页文字" : "创建提醒"}</strong>
            <p>{action.input.text || action.input.content || action.input.message || action.input.title}</p>
            <small>{action.input.date || action.input.datetime}</small>
            {action.status === "pending" ? <div><button onClick={() => setActions((items) => items.map((item) => item.id === action.id ? { ...item, status: "cancelled" } : item))}>取消</button><button onClick={async () => { try { await applyRuneAction(action); } catch (error) { setChatNotice(error instanceof Error ? error.message : "操作失败。"); } }}>确认</button></div> : <em>{action.status === "done" ? "✓ 已完成" : "已取消"}</em>}
          </article>
        ))}
      </section>

      <div className="claude-composer">
        {!!attachments.length && <div className="attachment-tray">{attachments.map((attachment) => <span key={attachment.id}>{attachment.kind === "image" ? "▧" : "≡"} {attachment.name}<button onClick={() => setAttachments(attachments.filter((item) => item.id !== attachment.id))} aria-label={`移除 ${attachment.name}`}>×</button></span>)}</div>}
        <div className="composer-input-row"><textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              sendMessage();
            }
          }}
          placeholder={`和 ${profile.name || "Rune"} 说点什么…`}
          aria-label="消息内容"
          rows={1}
        /></div>
        <input ref={attachmentRef} className="hidden-file" type="file" multiple accept="image/*,.txt,.md,.json,.csv,text/*" onChange={(event) => addAttachments(event.target.files)} />
        <div className="composer-tools">
          <button className="attach-button" onClick={() => attachmentRef.current?.click()} aria-label="添加附件">＋</button>
          {(
            <button
              className={listening ? "mic-button recording" : "mic-button"}
              onClick={sendVoiceMessage}
              aria-label={listening ? "停止录音并发送" : "按住说话"}
            >{listening ? <span className="recording-stop" /> : <MicrophoneIcon />}</button>
          )}
          {listening ? <small>{liveTranscript || "在听…"}</small> : claudeModels.length > 0 ? (
            <select className="chat-model-select" value={claudeModel} onChange={(event) => setClaudeModel(event.target.value)} aria-label="当前模型">
              {claudeModels.map((model) => <option key={model.id} value={model.id}>{model.display_name || model.id}</option>)}
            </select>
          ) : <small>{selectedModel?.display_name || "AI"}</small>}
          <button className="send-button" onClick={() => sendMessage()} disabled={(!input.trim() && !attachments.length) || sending} aria-label="发送消息">↑</button>
        </div>
      </div>
    </main>
  );
}

function SettingsView({
  aiApiBase,
  setAiApiBase,
  theme,
  setTheme,
  anniversaries,
  setAnniversaries,
  health,
  setHealth,
  mcpServers,
  setMcpServers,
  metDate,
  setMetDate,
  claudeKey,
  setClaudeKey,
  claudeModel,
  setClaudeModel,
  claudeModels,
  setClaudeModels,
  profile,
  setProfile,
  voiceConfig,
  setVoiceConfig,
  minimaxKey,
  setMinimaxKey,
}: {
  aiApiBase: string;
  setAiApiBase: (base: string) => void;
  profile: Profile;
  setProfile: (profile: Profile) => void;
  voiceConfig: VoiceConfig;
  setVoiceConfig: (config: VoiceConfig) => void;
  minimaxKey: string;
  setMinimaxKey: (key: string) => void;
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
  anniversaries: Anniversary[];
  setAnniversaries: (items: Anniversary[]) => void;
  health: HealthSummary;
  setHealth: (summary: HealthSummary) => void;
  mcpServers: McpServer[];
  setMcpServers: (servers: McpServer[]) => void;
  metDate: string;
  setMetDate: (date: string) => void;
  claudeKey: string;
  setClaudeKey: (key: string) => void;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  claudeModels: ClaudeModel[];
  setClaudeModels: (models: ClaudeModel[]) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [claudeStatus, setClaudeStatus] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [newMcp, setNewMcp] = useState({ name: "", url: "", authMode: "none" as "none" | "oauth" });
  const [mcpStatus, setMcpStatus] = useState("");
  const [avatarNote, setAvatarNote] = useState("");
  const voiceReady = Boolean(minimaxKey && voiceConfig.voiceId);
  const [voiceStatus, setVoiceStatus] = useState("");
  const [testingVoice, setTestingVoice] = useState(false);
  const [requestingMicrophone, setRequestingMicrophone] = useState(false);
  const [runningVoiceChecks, setRunningVoiceChecks] = useState(false);
  const [voiceChecks, setVoiceChecks] = useState({
    microphone: "尚未测试",
    minimax: "尚未测试",
    surface: "检测中…",
  });

  useEffect(() => {
    if (typeof globalThis.window === "undefined") return;
    const standalone = globalThis.matchMedia?.("(display-mode: standalone)").matches
      || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    const iphone = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    setVoiceChecks((current) => ({
      ...current,
      surface: standalone ? `${iphone ? "iPhone" : "设备"}主屏幕 PWA` : iphone ? "iPhone Safari 浏览器" : "普通浏览器页面",
    }));
  }, []);

  const requestMicrophonePermission = async () => {
    setRequestingMicrophone(true);
    setVoiceChecks((current) => ({ ...current, microphone: "正在请求授权…" }));
    try {
      if (!globalThis.isSecureContext) throw new Error("请先使用安全的 HTTPS 页面打开 Rune");
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器没有提供麦克风接口");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setVoiceChecks((current) => ({ ...current, microphone: "权限正常" }));
      return true;
    } catch (error) {
      const reason = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name)
        ? "权限被拒绝，请到系统设置中允许 Rune 使用麦克风"
        : error instanceof Error ? error.message : "权限不可用";
      setVoiceChecks((current) => ({ ...current, microphone: reason }));
      return false;
    } finally {
      setRequestingMicrophone(false);
    }
  };

  const runVoiceChecks = async () => {
    setRunningVoiceChecks(true);
    setVoiceChecks((current) => ({ ...current, minimax: "正在调用…" }));
    await requestMicrophonePermission();

    try {
      const url = await synthesizeSpeech("Rune 语音连接测试。", voiceConfig, minimaxKey);
      URL.revokeObjectURL(url);
      setVoiceChecks((current) => ({ ...current, minimax: "调用成功" }));
    } catch (error) {
      setVoiceChecks((current) => ({ ...current, minimax: error instanceof Error ? error.message : "调用失败" }));
    } finally {
      setRunningVoiceChecks(false);
    }
  };

  const testVoice = async () => {
    setTestingVoice(true);
    setVoiceStatus("");
    try {
      const url = await synthesizeSpeech(`你好，我是${profile.name || "Rune"}。这是一段试听。`, voiceConfig, minimaxKey);
      const audio = new Audio(url);
      await audio.play();
      audio.onended = () => URL.revokeObjectURL(url);
      setVoiceStatus("试听已开始播放。");
    } catch (error) {
      setVoiceStatus(error instanceof Error ? error.message : "试听失败。");
    } finally {
      setTestingVoice(false);
    }
  };
  const runeAvatarRef = useRef<HTMLInputElement>(null);
  const userAvatarRef = useRef<HTMLInputElement>(null);
  const [healthMessage, setHealthMessage] = useState("");
  const [notificationStatus, setNotificationStatus] = useState("");
  const [enablingNotifications, setEnablingNotifications] = useState(false);
  const [barkServer, setBarkServer] = useState("https://api.day.app");
  const [barkKey, setBarkKey] = useState("");

  useEffect(() => {
    if (typeof globalThis.document === "undefined") return;
    setBarkServer(localStorage.getItem("rune-bark-server") || "https://api.day.app");
    setBarkKey(localStorage.getItem("rune-bark-key") || "");
  }, []);

  const updateProfile = (patch: Partial<Profile>) => setProfile({ ...profile, ...patch });

  const pickAvatar = async (file: File | undefined, field: "avatar" | "userAvatar") => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setAvatarNote("请选择一张图片。");
      return;
    }
    try {
      const data = await readAvatar(file);
      updateProfile({ [field]: data } as Partial<Profile>);
      setAvatarNote(`已更新头像（约 ${Math.round(data.length * 2 / 1024)} KB）。`);
    } catch {
      setAvatarNote("这张图片读不出来，换一张试试。");
    }
  };

  const updateAnniversary = (id: number, field: "name" | "date", value: string) => {
    setAnniversaries(anniversaries.map((item) => item.id === id ? { ...item, [field]: value } : item));
  };

  const addAnniversary = () => {
    setAnniversaries([...anniversaries, { id: Date.now(), name: "新的纪念日", date: localDateKey(new Date()) }]);
  };

  const importHealth = async (file?: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xml")) {
      setHealthMessage("请先解压 Apple 导出的 ZIP，再选择里面的 export.xml。");
      return;
    }
    setHealthMessage(`正在解析（${Math.max(1, Math.round(file.size / 1024 / 1024))} MB）…`);
    // 先让这句渲染出来，否则大文件解析期间界面完全没反应
    await new Promise((resolve) => globalThis.setTimeout(resolve, 30));

    const text = await file.text();
    const readAttribute = (record: string, name: string) => record.match(new RegExp(`${name}="([^"]+)"`))?.[1];

    // 不要先把所有 <Record> 展开成数组：Apple 导出常有几十万条记录，
    // 那个中间数组比文件本身还大，手机上直接内存爆掉。改成单趟扫描，只留需要的两类。
    const stepRecords: Array<{ value: number; date: string }> = [];
    const heartRecords: number[] = [];
    const pattern = /<Record\b[^>]*\/>/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const record = match[0];
      if (record.includes('type="HKQuantityTypeIdentifierStepCount"')) {
        stepRecords.push({ value: Number(readAttribute(record, "value")), date: readAttribute(record, "startDate") || "" });
      } else if (record.includes('type="HKQuantityTypeIdentifierHeartRate"')) {
        const value = Number(readAttribute(record, "value"));
        if (Number.isFinite(value)) heartRecords.push(value);
      }
    }

    if (!stepRecords.length && !heartRecords.length) {
      setHealthMessage("这个文件里没找到步数或心率记录，确认选的是 export.xml。");
      return;
    }
    const latestDay = stepRecords.at(-1)?.date.slice(0, 10);
    const steps = stepRecords
      .filter((record) => !latestDay || record.date.startsWith(latestDay))
      .reduce((sum, record) => sum + record.value, 0);
    const heartRate = heartRecords.length ? Math.round(heartRecords.at(-1) || 0) : undefined;

    // 近七日每日步数，供首页柱状图使用（没有数据的那天为 0）。
    const dailyTotals = new Map<string, number>();
    for (const record of stepRecords) {
      const day = record.date.slice(0, 10);
      if (!day || !Number.isFinite(record.value)) continue;
      dailyTotals.set(day, (dailyTotals.get(day) || 0) + record.value);
    }
    const anchor = latestDay ? new Date(`${latestDay}T00:00:00`) : new Date();
    const week = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(anchor);
      day.setDate(anchor.getDate() - (6 - index));
      return Math.round(dailyTotals.get(localDateKey(day)) || 0);
    });

    const summary = {
      steps: steps || undefined,
      heartRate,
      importedAt: new Date().toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }),
      week: week.some((value) => value > 0) ? week : undefined,
    };
    setHealth(summary);
    setHealthMessage(`已读取 ${latestDay || "最近一天"}的数据。`);
  };

  const addMcp = () => {
    if (!newMcp.name.trim() || !newMcp.url.trim()) return;
    const server: McpServer = { id: Date.now(), name: newMcp.name.trim(), url: newMcp.url.trim(), authMode: newMcp.authMode, enabled: newMcp.authMode === "none", requiresAuth: newMcp.authMode === "oauth" };
    setMcpServers([...mcpServers, server]);
    setNewMcp({ name: "", url: "", authMode: "none" });
    if (server.authMode === "oauth") startMcpOAuth(server).catch((error) => setMcpStatus(error instanceof Error ? error.message : "OAuth 跳转失败"));
  };

  const loadClaudeModels = async () => {
    const base = normalizeAiApiBase(aiApiBase);
    if (!base) {
      setClaudeStatus("请先填写 API 地址。");
      return;
    }
    if (!claudeKey.trim()) {
      setClaudeStatus("请先填写 API Key。");
      return;
    }
    setLoadingModels(true);
    setClaudeStatus("");
    try {
      const protocol = apiProtocolFor(base);
      const response = await fetch(`${base}/models${protocol === "anthropic" ? "?limit=1000" : ""}`, {
        headers: protocol === "anthropic" ? {
          "x-api-key": claudeKey.trim(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        } : { authorization: `Bearer ${claudeKey.trim()}` },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message || "读取模型失败");
      const models = (result.data || result.models || []).map((model: ClaudeModel | string) => typeof model === "string"
        ? { id: model, display_name: model }
        : { ...model, id: String(model.id || ""), display_name: String(model.display_name || model.id || "") })
        .filter((model: ClaudeModel) => model.id) as ClaudeModel[];
      setClaudeModels(models);
      const preferred = models.find((model) => model.id === claudeModel)
        || models.find((model) => model.id.includes("sonnet-4-6"))
        || models.find((model) => model.id.includes("opus-4-6"))
        || models[0];
      if (preferred) setClaudeModel(preferred.id);
      localStorage.setItem("rune-claude-key", claudeKey.trim());
      localStorage.setItem("rune-ai-api-base", base);
      localStorage.setItem("rune-claude-models", JSON.stringify(models));
      if (preferred) localStorage.setItem("rune-claude-model", preferred.id);
      setClaudeStatus(`连接成功，读取到 ${models.length} 个可用模型。`);
    } catch (error) {
      setClaudeStatus(`连接失败：${error instanceof Error ? error.message : "请检查 API Key。"}`);
    } finally {
      setLoadingModels(false);
    }
  };

  const enableNotifications = async () => {
    setEnablingNotifications(true);
    setNotificationStatus("");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in globalThis)) throw new Error("当前浏览器不支持 Web Push。请先把 Rune 添加到 iPhone 主屏幕。");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("通知权限没有开启。可以稍后在 iPhone 设置里修改。");

      let deviceId = localStorage.getItem("rune-device-id") || "";
      let deviceToken = localStorage.getItem("rune-device-token") || "";
      if (!deviceId || !deviceToken) {
        const deviceResponse = await fetch(`${runeApiBase()}/api/devices`, { method: "POST" });
        const device = await readJson(deviceResponse, "注册设备");
        deviceId = String(device.deviceId || "");
        deviceToken = String(device.token || "");
        if (!deviceId || !deviceToken) throw new Error("注册设备失败：后端没有返回设备凭证。");
        localStorage.setItem("rune-device-id", deviceId);
        localStorage.setItem("rune-device-token", deviceToken);
      }

      const registration = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
      await registration.update();
      await syncNotificationProfile(profile);
      let keyResponse: Response;
      try {
        keyResponse = await fetch(`${runeApiBase()}/api/push/key`);
      } catch {
        throw new Error("通知服务目前无法连接，请稍后重试。");
      }
      const keyData = await readJson(keyResponse, "读取推送密钥");
      if (!keyData.publicKey) throw new Error("读取推送密钥失败：后端还没有配置 VAPID 公钥。");
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeBase64Url(String(keyData.publicKey)),
      });
      const subscriptionResponse = await fetch(`${runeApiBase()}/api/push/subscriptions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rune-device": deviceId, "x-rune-token": deviceToken },
        body: JSON.stringify(subscription.toJSON()),
      });
      await readJson(subscriptionResponse, "保存通知订阅");
      setNotificationStatus("通知已经开启。之后由 Rune 创建的提醒可以显示在锁屏。");
    } catch (error) {
      setNotificationStatus(error instanceof Error ? error.message : "开启通知失败。");
    } finally {
      setEnablingNotifications(false);
    }
  };

  const testBark = async () => {
    if (!barkKey.trim()) { setNotificationStatus("请先填写 Bark Device Key。"); return; }
    setEnablingNotifications(true);
    setNotificationStatus("");
    try {
      const { deviceId, deviceToken } = await ensureRuneDevice();
      const response = await fetch(`${runeApiBase()}/api/bark/test`, { method: "POST", headers: { "content-type": "application/json", "x-rune-device": deviceId, "x-rune-token": deviceToken }, body: JSON.stringify({ barkServer: barkServer.trim() || "https://api.day.app", barkKey: barkKey.trim(), runeName: profile.name || "Rune", runeAvatar: profile.avatar || "", title: "Bark 测试", content: "Bark 已经连接成功。" }) });
      await readJson(response, "Bark 测试");
      setNotificationStatus("Bark 测试通知已经发送。");
    } catch (error) {
      setNotificationStatus(error instanceof Error ? error.message : "Bark 测试失败。");
    } finally { setEnablingNotifications(false); }
  };

  return (
    <main className="page settings-page">
      <header className="section-title"><h1>Settings</h1><span className="settings-mark">⌘</span></header>

      <details className="settings-group">
        <summary><span><b>Rune</b><small>人设、指令与模型</small></span><i aria-hidden="true">›</i></summary>
        <div className="settings-group-body">
      <section className="settings-section">
        <div className="settings-heading"><p className="eyebrow">Profile</p><h2>头像与昵称</h2></div>

        <div className="identity-row">
          <button className="identity-avatar" onClick={() => runeAvatarRef.current?.click()} aria-label="更换 Rune 头像">
            {profile.avatar ? <img src={profile.avatar} alt="" /> : <span>{initialOf(profile.name, "R")}</span>}
          </button>
          <div className="identity-fields">
            <p className="eyebrow">Rune</p>
            <input value={profile.name} onChange={(event) => updateProfile({ name: event.target.value })} placeholder="Rune" autoComplete="off" aria-label="Rune 昵称" />
          </div>
          {profile.avatar && <button className="remove-row" onClick={() => updateProfile({ avatar: "" })} aria-label="移除 Rune 头像">×</button>}
        </div>

        <div className="identity-row">
          <button className="identity-avatar" onClick={() => userAvatarRef.current?.click()} aria-label="更换我的头像">
            {profile.userAvatar ? <img src={profile.userAvatar} alt="" /> : <span>{initialOf(profile.userName, "我")}</span>}
          </button>
          <div className="identity-fields">
            <p className="eyebrow">user</p>
            <input value={profile.userName} onChange={(event) => updateProfile({ userName: event.target.value })} placeholder="user" autoComplete="off" aria-label="user 昵称" />
          </div>
          {profile.userAvatar && <button className="remove-row" onClick={() => updateProfile({ userAvatar: "" })} aria-label="移除我的头像">×</button>}
        </div>

        <input ref={runeAvatarRef} className="hidden-file" type="file" accept="image/*"
          onChange={(event) => pickAvatar(event.target.files?.[0], "avatar")} />
        <input ref={userAvatarRef} className="hidden-file" type="file" accept="image/*"
          onChange={(event) => pickAvatar(event.target.files?.[0], "userAvatar")} />
        {avatarNote && <p className="setting-note">{avatarNote}</p>}
        <p className="setting-note">头像会自动裁成正方形并缩到 160px（约 8KB）再保存，不会占满存储。昵称会用在对话气泡和首页问候语上。</p>
      </section>

      <section className="settings-section">
        <div className="settings-heading"><p className="eyebrow">Instructions</p><h2>人设与指令</h2></div>
        <label className="field-label">Instructions
          <textarea
            className="instructions-input"
            value={profile.instructions}
            onChange={(event) => updateProfile({ instructions: event.target.value })}
            placeholder="描述 Rune 是谁、怎么说话、要避免什么……这段会作为 system prompt 发给所选模型。"
            rows={7}
          />
        </label>
        <p className="setting-note">这段直接作为 system prompt。当前日期、时区和工具调用说明会由程序自动追加在后面，不用你写。</p>
      </section>

      <section className="settings-section">
        <div className="settings-heading"><p className="eyebrow">AI connection</p><h2>通用 AI API</h2></div>
        <label className="field-label">API 地址<input type="url" value={aiApiBase} onChange={(event) => { setAiApiBase(event.target.value); setClaudeStatus(""); }} placeholder="https://api.example.com/v1" autoComplete="off" /></label>
        <label className="field-label">API Key<input type="password" value={claudeKey} onChange={(event) => { setClaudeKey(event.target.value); localStorage.setItem("rune-claude-key", event.target.value); setClaudeStatus(""); }} placeholder="sk-••••••••" autoComplete="off" /></label>
        <button className="solid-action" onClick={loadClaudeModels} disabled={loadingModels}>
          {loadingModels ? "正在读取…" : "读取这个 Key 的可用模型"}
        </button>
        <label className="field-label">当前模型
          <select value={claudeModel} onChange={(event) => setClaudeModel(event.target.value)} disabled={!claudeModels.length}>
            {!claudeModels.length && <option value="">连接后选择模型</option>}
            {claudeModels.map((model) => <option key={model.id} value={model.id}>{model.display_name || model.id}</option>)}
          </select>
        </label>
        {claudeStatus && <p className={claudeStatus.startsWith("连接成功") ? "success-note" : "error-note"}>{claudeStatus}</p>}
        <p className="setting-note">兼容 Anthropic 原生接口，以及提供 <code>/models</code> 与 <code>/chat/completions</code> 的 OpenAI-compatible 接口。部分服务商会阻止浏览器直连，这种情况需要开启 CORS 或使用服务器代理。</p>
      </section>
      <section className="settings-section">
        <div className="settings-heading"><p className="eyebrow">Voice</p><h2>语音（MiniMax）</h2></div>
        <label className="field-label">API Key
          <input type="password" value={minimaxKey} autoComplete="off" placeholder="控制台 → 接口密钥 里创建"
            onChange={(event) => { setMinimaxKey(event.target.value); localStorage.setItem(MINIMAX_KEY_STORAGE, event.target.value); setVoiceStatus(""); }} />
        </label>
        <label className="field-label">Group ID
          <input value={voiceConfig.groupId} autoComplete="off" placeholder="控制台账户信息里那串数字（国际站账号留空）"
            onChange={(event) => setVoiceConfig({ ...voiceConfig, groupId: event.target.value.trim() })} />
        </label>
        <label className="field-label">Voice ID
          <input value={voiceConfig.voiceId} autoComplete="off" placeholder="Voice Library 里那个克隆音色的 voice_id"
            onChange={(event) => setVoiceConfig({ ...voiceConfig, voiceId: event.target.value.trim() })} />
        </label>
        <label className="field-label">模型
          <input value={voiceConfig.model} autoComplete="off" placeholder="speech-02-hd"
            onChange={(event) => setVoiceConfig({ ...voiceConfig, model: event.target.value.trim() })} />
        </label>
        <label className="field-label">接口地址
          <input type="url" value={voiceConfig.endpoint} autoComplete="off" placeholder={defaultVoiceConfig.endpoint} list="minimax-endpoints"
            onChange={(event) => setVoiceConfig({ ...voiceConfig, endpoint: event.target.value.trim() })} />
        </label>
        <label className="field-label">语速 {voiceConfig.speed.toFixed(1)}×
          <input type="range" min="0.5" max="2" step="0.1" value={voiceConfig.speed}
            onChange={(event) => setVoiceConfig({ ...voiceConfig, speed: Number(event.target.value) })} />
        </label>
        <div className="mcp-row">
          <button className={voiceConfig.autoPlay ? "mini-switch on" : "mini-switch"} onClick={() => setVoiceConfig({ ...voiceConfig, autoPlay: !voiceConfig.autoPlay })} aria-label="自动朗读"><i /></button>
          <span><strong>语音消息自动播放</strong><small>收到语音消息时直接响，不用点</small></span>
        </div>
        <button className="solid-action" onClick={testVoice} disabled={testingVoice}>{testingVoice ? "正在合成…" : "试听"}</button>
        {voiceStatus && <p className={voiceStatus.startsWith("试听") ? "success-note" : "error-note"}>{voiceStatus}</p>}
        <datalist id="minimax-endpoints">
          <option value="https://api.minimax.chat/v1/t2a_v2">国内站 platform.minimaxi.com</option>
          <option value="https://api.minimaxi.com/v1/t2a_v2">国内站（备用域名）</option>
          <option value="https://api.minimax.io/v1/t2a_v2">国际站 platform.minimax.io</option>
        </datalist>
        <div className="capability-check">
          <div className="capability-check-head"><p className="eyebrow">语音测试</p><button onClick={runVoiceChecks} disabled={runningVoiceChecks}>{runningVoiceChecks ? "测试中…" : "全部测试"}</button></div>
          <ul>
            <li className="capability-action-row"><b className={voiceChecks.microphone === "权限正常" ? "ok" : ""}>1</b><span>麦克风权限<small>{voiceChecks.microphone}</small></span><button onClick={requestMicrophonePermission} disabled={requestingMicrophone}>{requestingMicrophone ? "请求中…" : "请求权限"}</button></li>
            <li><b className={voiceChecks.minimax === "调用成功" ? "ok" : ""}>2</b><span>MiniMax 可否调用<small>{voiceChecks.minimax}</small></span></li>
            <li><b className="ok">3</b><span>当前打开界面<small>{voiceChecks.surface}</small></span></li>
          </ul>
        </div>
        <p className="setting-note">Key 和语音配置会保存在这台设备，不会上传到 Rune 后端；清除网站数据或删除 PWA 时会一并移除。<br/>{profile.name || "Rune"} 会自己判断什么时候用语音说话（情绪浓的时候），不是每条都念，所以不会一直烧额度。语音识别用系统自带能力，不额外收费。</p>
      </section>

      <section className="settings-section">
        <div className="settings-heading"><p className="eyebrow">Tools</p><h2>MCP 连接</h2></div>
        <div className="mcp-list">
          {mcpServers.map((server) => (
            <div className="mcp-row" key={server.id}>
              <button className={server.enabled ? "mini-switch on" : "mini-switch"} onClick={() => setMcpServers(mcpServers.map((item) => item.id === server.id ? { ...item, enabled: !item.enabled } : item))}><i /></button>
              <span><strong>{server.name}</strong><small>{server.url} · {server.authMode === "oauth" ? (server.token ? "OAuth 已连接" : "OAuth 未连接") : "无 OAuth"}</small>{server.authMode === "oauth" && !server.token && <button className="mcp-oauth-button" onClick={() => startMcpOAuth(server).catch((error) => setMcpStatus(error instanceof Error ? error.message : "OAuth 跳转失败"))}>前往验证</button>}</span>
              <button className="remove-row" onClick={() => setMcpServers(mcpServers.filter((item) => item.id !== server.id))}>×</button>
            </div>
          ))}
        </div>
        <div className="mcp-add">
          <input value={newMcp.name} onChange={(event) => setNewMcp({ ...newMcp, name: event.target.value })} placeholder="名称，如 Notion" />
          <input value={newMcp.url} onChange={(event) => setNewMcp({ ...newMcp, url: event.target.value })} placeholder="https://…/mcp" />
          <select value={newMcp.authMode} onChange={(event) => setNewMcp({ ...newMcp, authMode: event.target.value as "none" | "oauth" })}><option value="none">无 OAuth</option><option value="oauth">OAuth</option></select>
          <button className="outline-action" onClick={addMcp}>＋ 添加 MCP</button>
        </div>
        {mcpStatus && <p className="error-note">{mcpStatus}</p>}
      </section>
        </div>
      </details>

      <details className="settings-group">
        <summary><span><b>Us</b><small>认识的日子与纪念日</small></span><i aria-hidden="true">›</i></summary>
        <div className="settings-group-body">
      <section className="settings-section">
        <div className="settings-heading"><p className="eyebrow">Us</p><h2>和 Rune 认识的日期</h2></div>
        <label className="field-label">开始日期<input type="date" value={metDate} onChange={(event) => setMetDate(event.target.value)} /></label>
        <p className="setting-note">{metDate ? `首页会每天自动更新，目前是第 ${daysTogether(metDate)} 天。` : "设置后，首页的 Day 数字会每天自动更新。"}</p>
      </section>
      <section className="settings-section">
        <div className="settings-heading"><p className="eyebrow">Important dates</p><h2>纪念日</h2></div>
        <div className="editable-list">
          {anniversaries.map((item) => (
            <div className="editable-row" key={item.id}>
              <input aria-label="纪念日名称" value={item.name} onChange={(event) => updateAnniversary(item.id, "name", event.target.value)} />
              <input aria-label={`${item.name}日期`} type="date" value={item.date} onChange={(event) => updateAnniversary(item.id, "date", event.target.value)} />
              <button aria-label={`删除${item.name}`} onClick={() => setAnniversaries(anniversaries.filter((date) => date.id !== item.id))}>×</button>
            </div>
          ))}
        </div>
        <button className="outline-action" onClick={addAnniversary}>＋ 添加纪念日</button>
        <p className="setting-note">会自动保存在这台设备，首页倒数天数实时计算。</p>
      </section>
        </div>
      </details>

      <details className="settings-group">
        <summary><span><b>Data</b><small>健康数据与通知</small></span><i aria-hidden="true">›</i></summary>
        <div className="settings-group-body">
      <section className="settings-section">
        <div className="settings-heading"><p className="eyebrow">Health data</p><h2>Apple Health</h2></div>
        <div className="connection-card">
          <span className="connection-icon health-icon">♥</span>
          <span><strong>{health.importedAt ? "已导入 Health 数据" : "尚未连接"}</strong><small>{health.importedAt ? `上次导入：${health.importedAt}` : "网页版不能直接弹出 HealthKit 授权"}</small></span>
        </div>
        <input ref={fileRef} className="hidden-file" type="file" accept=".xml,text/xml" onChange={(event) => importHealth(event.target.files?.[0])} />
        <button className="solid-action" onClick={() => fileRef.current?.click()}>导入 export.xml</button>
        <a className="outline-action link-action" href="https://support.apple.com/guide/iphone/share-your-health-data-iph5ede58c3d/ios" target="_blank" rel="noreferrer">查看 Apple 导出教程 ↗</a>
        {healthMessage && <p className="success-note">{healthMessage}</p>}
        <p className="setting-note">直接 HealthKit 授权需要后续做一个 iPhone 原生伴侣 App；这一版先支持 Apple 官方导出的 XML，数据只在本机解析和保存。</p>
      </section>
      <section className="settings-section">
        <div className="settings-heading"><p className="eyebrow">Reminders</p><h2>系统通知</h2></div>
        <div className="connection-card">
          <span className="connection-icon notification-icon">◉</span>
          <span><strong>Rune 定时提醒</strong><small>在锁屏、通知中心和 Apple Watch 显示</small></span>
        </div>
        <label className="field-label">Bark 服务器
          <input type="url" inputMode="url" value={barkServer} onChange={(event) => { setBarkServer(event.target.value); localStorage.setItem("rune-bark-server", event.target.value.trim().replace(/\/+$/, "")); }} placeholder="https://api.day.app" autoComplete="off" />
        </label>
        <label className="field-label">Bark Device Key
          <input type="password" value={barkKey} onChange={(event) => { setBarkKey(event.target.value); localStorage.setItem("rune-bark-key", event.target.value.trim()); }} placeholder="Bark App 中显示的设备 Key" autoComplete="off" />
        </label>
        <button className="solid-action" onClick={testBark} disabled={enablingNotifications || !barkKey.trim()}>
          {enablingNotifications ? "正在发送…" : "测试 Bark 通知"}
        </button>
        {notificationStatus && <p className={notificationStatus.startsWith("Bark 测试通知") ? "success-note" : "error-note"}>{notificationStatus}</p>}
        <p className="setting-note">填写 Bark 后，Rune 创建提醒时会把 LLM 编辑的标题和正文交给后端，到点后通过 Bark 发送；未填写时使用系统 Web Push。通知发送者名称与头像跟随 Rune 设置。Bark Key 只保存在本机，并在创建提醒时发给你配置的提醒后端。</p>
      </section>
        </div>
      </details>

      <details className="settings-group">
        <summary><span><b>Appearance</b><small>主题外观</small></span><i aria-hidden="true">›</i></summary>
        <div className="settings-group-body">
      <section className="settings-section">
        <div className="settings-heading"><p className="eyebrow">Appearance</p><h2>主题颜色</h2></div>
        <div className="theme-options">
          {(Object.keys(themes) as ThemeName[]).map((key) => (
            <button key={key} className={theme === key ? "theme-option active" : "theme-option"} onClick={() => setTheme(key)}>
              <i style={{ background: themes[key].swatch }} />
              <span>{themes[key].label}</span>
              <b>{theme === key ? "✓" : ""}</b>
            </button>
          ))}
        </div>
      </section>
        </div>
      </details>

    </main>
  );
}

function SplashScreen({ leaving }: { leaving: boolean }) {
  return (
    <div className={leaving ? "splash-screen leaving" : "splash-screen"} aria-hidden="true">
      <div className="splash-mark">
        <img src="./pulse-icon-claude.png" alt="" />
      </div>
      <div className="splash-word">
        <strong>Rune</strong>
        <span>your quiet space</span>
      </div>
    </div>
  );
}

function NavIcon({ name }: { name: "home" | "chat" | "diary" | "settings" }) {
  const common = { width: 23, height: 23, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.65, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "home") return <svg {...common}><path d="M3.4 11.2 12 4l8.6 7.2"/><path d="M5.5 10.1v9.4h13v-9.4M9.3 19.5v-5.8h5.4v5.8"/><path d="M8.2 6.9V4.6h2"/></svg>;
  if (name === "chat") return <svg {...common}><path d="M20.3 11.5c0 4.1-3.8 7.3-8.4 7.3-1.1 0-2.2-.2-3.2-.5L4 19.7l1.5-3.9a6.7 6.7 0 0 1-1.9-4.6C3.6 7.1 7.3 4 12 4s8.3 3.2 8.3 7.5Z"/><path d="M8.2 10.7h7.6M8.2 14h4.8"/></svg>;
  if (name === "diary") return <svg {...common}><path d="M6.1 3.5h10.7a2 2 0 0 1 2 2v15H7.4a2.2 2.2 0 0 1-2.2-2.2V5.5c0-1.1.9-2 2-2"/><path d="M8.4 3.5v17M11.6 8h4.1M11.6 11.5h4.1M11.6 15h2.7"/></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="3.1"/><path d="m19.2 13.4 1.3 1-.2 1.6-1.6.7-.8 1.3.2 1.7-1.5.8-1.3-1.1-1.5.3-.9 1.4h-1.8l-.9-1.4-1.5-.3-1.3 1.1-1.5-.8.2-1.7-.8-1.3-1.6-.7-.2-1.6 1.3-1v-1.6l-1.3-1 .2-1.6 1.6-.7.8-1.3-.2-1.7 1.5-.8 1.3 1.1 1.5-.3.9-1.4h1.8l.9 1.4 1.5.3 1.3-1.1 1.5.8-.2 1.7.8 1.3 1.6.7.2 1.6-1.3 1Z"/></svg>;
}

export default function Pulse() {
  const [tab, setTab] = useState<Tab>("home");
  const [theme, setTheme] = useState<ThemeName>("paper");
  const [anniversaries, setAnniversaries] = useState<Anniversary[]>(defaultAnniversaries);
  const [health, setHealth] = useState<HealthSummary>({});
  const [mcpServers, setMcpServers] = useState<McpServer[]>(defaultMcpServers);
  const [metDate, setMetDate] = useState("");
  const [claudeKey, setClaudeKey] = useState("");
  const [aiApiBase, setAiApiBase] = useState("https://api.anthropic.com/v1");
  const [claudeModel, setClaudeModel] = useState("");
  const [claudeModels, setClaudeModels] = useState<ClaudeModel[]>([]);
  const [profile, setProfile] = useState<Profile>(defaultProfile);
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>(defaultVoiceConfig);
  const [minimaxKey, setMinimaxKey] = useState("");
  const [homeMessage, setHomeMessage] = useState("今天也辛苦了。");
  const [homeMessageAt, setHomeMessageAt] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const updateHomeMessage = (message: string) => {
    setHomeMessage(message);
    setHomeMessageAt(Date.now());
  };
  const [splashState, setSplashState] = useState<"visible" | "leaving" | "hidden">("visible");
  const tabTitle = useMemo(() => ({ home: "首页", chat: "对话", diary: "日记", settings: "设置" })[tab], [tab]);

  useEffect(() => {
    if (typeof globalThis.document === "undefined") return;
    const leaveTimer = globalThis.setTimeout(() => setSplashState("leaving"), 1550);
    const hideTimer = globalThis.setTimeout(() => setSplashState("hidden"), 2050);
    return () => {
      globalThis.clearTimeout(leaveTimer);
      globalThis.clearTimeout(hideTimer);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const viewport = window.visualViewport;
    let layoutHeight = Math.max(window.innerHeight, viewport.height);
    const updateKeyboardCover = () => {
      const active = document.activeElement as HTMLElement | null;
      const isTyping = !!active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
      if (!isTyping) layoutHeight = Math.max(window.innerHeight, viewport.height);
      const covered = Math.max(0, layoutHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty("--keyboard-cover", `${covered}px`);
    };
    updateKeyboardCover();
    viewport.addEventListener("resize", updateKeyboardCover);
    viewport.addEventListener("scroll", updateKeyboardCover);
    document.addEventListener("focusin", updateKeyboardCover);
    document.addEventListener("focusout", updateKeyboardCover);
    return () => {
      viewport.removeEventListener("resize", updateKeyboardCover);
      viewport.removeEventListener("scroll", updateKeyboardCover);
      document.removeEventListener("focusin", updateKeyboardCover);
      document.removeEventListener("focusout", updateKeyboardCover);
      document.documentElement.style.removeProperty("--keyboard-cover");
    };
  }, []);

  useEffect(() => {
    if (typeof globalThis.document === "undefined") return;
    try {
      const stored = localStorage.getItem("pulse-preferences");
      if (stored) {
        const data = JSON.parse(stored);
        if (data.theme && data.theme in themes) setTheme(data.theme);
        if (data.anniversaries) setAnniversaries(data.anniversaries);
        if (data.health) setHealth(data.health);
        if (data.mcpServers) setMcpServers(data.mcpServers);
        if (data.metDate) setMetDate(data.metDate);
        if (data.homeMessage) setHomeMessage(data.homeMessage);
        if (data.homeMessageAt) setHomeMessageAt(data.homeMessageAt);
        if (data.profile) {
          const storedProfile = { ...defaultProfile, ...data.profile } as Profile;
          if (!storedProfile.userName || ["沈澈", "kiki"].includes(storedProfile.userName)) storedProfile.userName = "user";
          setProfile(storedProfile);
        }
        if (data.voiceConfig) setVoiceConfig({ ...defaultVoiceConfig, ...data.voiceConfig });
      }
      const migrateValue = (key: string, fallback = "") => {
        const value = localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? fallback;
        if (value) localStorage.setItem(key, value);
        sessionStorage.removeItem(key);
        return value;
      };
      setMinimaxKey(migrateValue(MINIMAX_KEY_STORAGE));
      setClaudeKey(migrateValue("rune-claude-key"));
      setAiApiBase(migrateValue("rune-ai-api-base", "https://api.anthropic.com/v1"));
      setClaudeModel(migrateValue("rune-claude-model"));
      const storedModels = migrateValue("rune-claude-models");
      if (storedModels) setClaudeModels(JSON.parse(storedModels));
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (typeof globalThis.document === "undefined") return;
    if (!hydrated) return;
    localStorage.setItem("pulse-preferences", JSON.stringify({ theme, anniversaries, health, mcpServers, metDate, homeMessage, homeMessageAt, profile, voiceConfig }));
  }, [theme, anniversaries, health, mcpServers, metDate, homeMessage, homeMessageAt, profile, hydrated]);

  useEffect(() => {
    if (hydrated) syncNotificationProfile(profile).catch(() => undefined);
  }, [profile.name, profile.avatar, hydrated]);

  useEffect(() => {
    if (!hydrated || typeof location === "undefined") return;
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    const pendingRaw = localStorage.getItem("rune-mcp-oauth-pending");
    if (!code || !pendingRaw) return;
    const pending = JSON.parse(pendingRaw) as { serverId: number; verifier: string; state: string; redirectUri: string; tokenEndpoint: string; clientId: string };
    if (!returnedState || returnedState !== pending.state) return;
    fetch(pending.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: pending.clientId, redirect_uri: pending.redirectUri, code_verifier: pending.verifier }),
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok || !data.access_token) throw new Error(data.error_description || "OAuth Token 交换失败");
      setMcpServers((items) => items.map((item) => item.id === pending.serverId ? { ...item, token: data.access_token, enabled: true, requiresAuth: true } : item));
      localStorage.removeItem("rune-mcp-oauth-pending");
      history.replaceState({}, "", location.pathname);
    }).catch(() => undefined);
  }, [hydrated]);

  useEffect(() => {
    if (typeof globalThis.document === "undefined" || !claudeModel) return;
    localStorage.setItem("rune-claude-model", claudeModel);
  }, [claudeModel]);

  useEffect(() => {
    if (typeof globalThis.document === "undefined") return;
    localStorage.setItem("rune-ai-api-base", normalizeAiApiBase(aiApiBase));
  }, [aiApiBase]);

  return (
    <div className={`app theme-${theme}`}>
      {splashState !== "hidden" && <SplashScreen leaving={splashState === "leaving"} />}
      <div className="ambient one" />
      <div className="ambient two" />
      <div className="phone-shell">
        <div className="status-spacer" />
        {tab === "home" && <HomeView goDiary={() => setTab("diary")} goChat={() => setTab("chat")} goSettings={() => setTab("settings")} anniversaries={anniversaries} health={health} metDate={metDate} homeMessage={homeMessage} homeMessageAt={homeMessageAt} profile={profile} />}
        <div className="persistent-chat-panel" hidden={tab !== "chat"}>
          <ChatView aiApiBase={aiApiBase} claudeKey={claudeKey} claudeModel={claudeModel} claudeModels={claudeModels} setClaudeModel={setClaudeModel} goSettings={() => setTab("settings")} mcpServers={mcpServers} setHomeMessage={updateHomeMessage} profile={profile} voiceConfig={voiceConfig} minimaxKey={minimaxKey} />
        </div>
        {tab === "diary" && <DiaryView profile={profile} />}
        {tab === "settings" && <SettingsView aiApiBase={aiApiBase} setAiApiBase={setAiApiBase} theme={theme} setTheme={setTheme} anniversaries={anniversaries} setAnniversaries={setAnniversaries} health={health} setHealth={setHealth} mcpServers={mcpServers} setMcpServers={setMcpServers} metDate={metDate} setMetDate={setMetDate} claudeKey={claudeKey} setClaudeKey={setClaudeKey} claudeModel={claudeModel} setClaudeModel={setClaudeModel} claudeModels={claudeModels} setClaudeModels={setClaudeModels} profile={profile} setProfile={setProfile} voiceConfig={voiceConfig} setVoiceConfig={setVoiceConfig} minimaxKey={minimaxKey} setMinimaxKey={setMinimaxKey} />}

        <nav className="bottom-nav" aria-label="主导航">
          <button className={tab === "home" ? "active" : ""} onClick={() => setTab("home")} aria-label="首页"><i><NavIcon name="home" /></i><span>Home</span></button>
          <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")} aria-label="对话"><i><NavIcon name="chat" /></i><span>Chats</span></button>
          <button className={tab === "diary" ? "active" : ""} onClick={() => setTab("diary")} aria-label="日记"><i><NavIcon name="diary" /></i><span>Diary</span></button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")} aria-label="设置"><i><NavIcon name="settings" /></i><span>Settings</span></button>
        </nav>
        <span className="sr-only" aria-live="polite">当前页面：{tabTitle}</span>
      </div>
    </div>
  );
}
