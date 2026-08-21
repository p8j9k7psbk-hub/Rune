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
  assert.match(page, /输出音频会话交还给麦克风/);
  assert.match(page, /正在重试/);
  assert.match(page, /请求权限/);
  assert.match(page, /globalThis\.isSecureContext/);
  assert.match(page, /localStorage\.setItem\("rune-claude-key"/);
  assert.match(page, /localStorage\.setItem\(MINIMAX_KEY_STORAGE/);
  assert.match(page, /indexedDB\.open\(RUNE_LOCAL_DB/);
  assert.match(page, /loadConversations/);
  assert.doesNotMatch(page, /已清掉.*最旧的对话/);
  assert.match(page, /const migrateValue =/);
  assert.match(page, /callMcpRpc/);
  assert.match(page, /"tools\/list"/);
  assert.match(page, /"tools\/call"/);
  assert.match(page, /mcp_toolset/);
  assert.match(page, /authorization_token/);
  assert.match(page, /startMcpOAuth/);
  assert.match(page, /无 OAuth/);
  assert.match(page, /Rune Web Push/);
  assert.match(page, /发送测试通知/);
  assert.doesNotMatch(page, /Bark Device Key/);
  assert.match(page, /Duration:/);
  assert.match(page, /旧语音通话/);
  assert.match(page, /start_voice_call/);
  assert.match(page, /directCallRequested/);
  assert.match(page, /releaseCallSpeaker/);
  assert.match(page, /继续说/);
  assert.match(page, /audio\.ontimeupdate/);
  assert.match(page, /每一轮都重新建立输入通道/);
  assert.match(page, /one tool response for every tool_call_id/);
  assert.match(page, /Rune will handle this local tool call/);
  assert.match(page, /sameVoiceClaim/);
  assert.match(page, /turnSequence: number/);
  assert.match(page, /echoCancellation: true/);
  assert.match(page, /系统 SpeechRecognition 需要独占麦克风/);
  assert.match(page, /需要新的用户手势/);
  assert.match(page, /编辑前记录/);
  assert.match(page, /\[\[split\]\]/);
  assert.match(page, /\[\[voice\]\]/);
  assert.match(page, /麦克风权限/);
  assert.match(page, /ElevenLabs.*MiniMax|MiniMax.*ElevenLabs/s);
  assert.match(page, /xi-api-key/);
  assert.match(page, /当前打开界面/);
  assert.match(page, /profile\.userName \|\| "user"/);
  assert.match(page, /<p className="eyebrow">user<\/p>/);
  assert.match(page, /value=\{profile\.userName\} onChange=/);
  assert.match(page, /storedProfile\.userName = "user"/);
  assert.match(page, /<details className="settings-group">\s*<summary><span><b>Rune<\/b>/);
  assert.match(page, /<summary><span><p className="eyebrow">Voice<\/p><b>语音<\/b>/);
  assert.match(page, /<details className="settings-subgroup">/);
  assert.match(page, /<summary><span><b>Tools<\/b><small>MCP、健康数据与提醒/);
  assert.match(page, /<span>自选<\/span>/);
  assert.match(mobileCss, /font-size:\s*16px !important/);
  assert.match(entryHtml, /maximum-scale=1/);
});
