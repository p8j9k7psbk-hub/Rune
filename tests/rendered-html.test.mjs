import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Rune home page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Rune — 私人生活空间<\/title>/i);
  assert.match(html, /user/);
  assert.match(html, /aria-label="主导航"/);
  assert.match(html, /Home/);
  assert.match(html, /Chats/);
  assert.match(html, /Diary/);
  assert.match(html, /Settings/);
  assert.doesNotMatch(html, /codex-preview|Building your site/);
});

test("keeps required AI, voice, and mobile behavior", async () => {
  const [page, mobileCss, entryHtml] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/mobile-fixes.css", import.meta.url), "utf8"),
    readFile(new URL("../static-index.html", import.meta.url), "utf8"),
  ]);
  assert.match(page, /userName:\s*"user"/);
  assert.match(page, /fetch\(`\$\{base\}\/models/);
  assert.match(page, /SpeechRecognition \|\| scope\.webkitSpeechRecognition/);
  assert.doesNotMatch(page, /const sttSupported/);
  assert.match(page, /className="voice-call-button call-button"/);
  assert.match(page, /"mic-button recording"/);
  assert.match(page, /runVoiceChecks/);
  assert.match(page, /requestMicrophonePermission/);
  assert.match(page, /messagesRef\.current/);
  assert.match(page, /messageStreamRef/);
  assert.match(page, /rows=\{1\}/);
  assert.match(page, /claude-composer[\s\S]*chat-model-select/);
  assert.match(page, /释放扬声器音频会话/);
  assert.match(page, /正在重试/);
  assert.match(page, /请求权限/);
  assert.match(page, /globalThis\.isSecureContext/);
  assert.match(page, /localStorage\.setItem\("rune-claude-key"/);
  assert.match(page, /localStorage\.setItem\(MINIMAX_KEY_STORAGE/);
  assert.match(page, /const migrateValue =/);
  assert.match(page, /麦克风权限/);
  assert.match(page, /MiniMax 可否调用/);
  assert.match(page, /当前打开界面/);
  assert.match(page, /profile\.userName \|\| "user"/);
  assert.match(page, /<p className="eyebrow">user<\/p>/);
  assert.match(page, /value=\{profile\.userName\} onChange=/);
  assert.match(page, /storedProfile\.userName = "user"/);
  assert.match(page, /<details className="settings-group">\s*<summary><span><b>Rune<\/b>/);
  assert.match(page, /语音（MiniMax）/);
  assert.match(mobileCss, /font-size:\s*16px !important/);
  assert.match(entryHtml, /maximum-scale=1/);
});
