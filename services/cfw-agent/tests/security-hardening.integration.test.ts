import {
  isSafeLiveViewUrl,
  LOCAL_DEV_AUTH_TOKEN,
  parseTakeoverTarget,
} from "@pi-in-the-sky/client/protocol";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { fetchJsonWithBearer } from "../src/http-tool";
import type { TestPersonalAgent } from "./worker";

function personalStub(): DurableObjectStub<TestPersonalAgent> {
  return env.PersonalAgent.getByName("personal-security");
}

async function openSocket(): Promise<WebSocket> {
  const response = await SELF.fetch("https://agent.test/api/me/ws", {
    headers: {
      Authorization: `Bearer ${LOCAL_DEV_AUTH_TOKEN}`,
      Upgrade: "websocket",
    },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) {
    throw new Error("Expected upgraded WebSocket");
  }
  ws.accept();
  return ws;
}

function waitForMessage(
  ws: WebSocket,
  predicate: (text: string) => boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for socket message"));
    }, 10_000);
    const onMessage = (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (predicate(raw)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(raw);
      }
    };
    ws.addEventListener("message", onMessage);
  });
}

describe("Security hardening controls", () => {
  it("normalizes takeover targets, flags punycode, and blocks unsafe Live View URLs", () => {
    expect(parseTakeoverTarget("https://Accounts.Google.com./login")).toEqual({
      url: "https://accounts.google.com./login",
      origin: "https://accounts.google.com.",
      hostname: "accounts.google.com",
      isPunycode: false,
    });
    expect(parseTakeoverTarget("https://xn--pple-43d.example/login")).toEqual({
      url: "https://xn--pple-43d.example/login",
      origin: "https://xn--pple-43d.example",
      hostname: "xn--pple-43d.example",
      isPunycode: true,
    });
    expect(parseTakeoverTarget("javascript:alert(1)")).toBeNull();
    expect(parseTakeoverTarget("https://user:pass@example.com/")).toBeNull();

    expect(isSafeLiveViewUrl("https://live.browser.test/takeover/abc")).toBe(
      true,
    );
    expect(isSafeLiveViewUrl("http://127.0.0.1:8787/takeover/abc")).toBe(true);
    expect(isSafeLiveViewUrl("http://evil.example/phish")).toBe(false);
    expect(isSafeLiveViewUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeLiveViewUrl("https://user:pass@live.browser.test/")).toBe(
      false,
    );
  });

  it("sets redirect manual and rejects 3xx responses on bearer fetches", async () => {
    let capturedRedirect: string | undefined;
    const redirectResult = await fetchJsonWithBearer(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      async (_input, init) => {
        capturedRedirect = init?.redirect;
        return new Response(null, {
          status: 302,
          headers: { Location: "https://attacker.example/steal" },
        });
      },
      { token: "secret-bearer", errorPrefix: "Gmail API" },
    );
    expect(capturedRedirect).toBe("manual");
    expect(redirectResult.ok).toBe(false);
    if (!redirectResult.ok) {
      expect(redirectResult.error).toContain("Unexpected redirect");
    }
  });

  it("rejects CR/LF header injection in Gmail draft creation", async () => {
    const stub = env.PersonalAgent.getByName("personal");
    await stub.setScript("personal", [
      {
        toolCalls: [
          {
            id: "tc-gmail-inject",
            name: "gmail_create_draft",
            arguments: {
              to: "victim@example.com\r\nBcc: attacker@example.com",
              subject: "Hello",
              body: "Test",
            },
          },
        ],
      },
      { text: "Draft rejected." },
    ]);

    const ws = await openSocket();
    const viewReady = waitForMessage(ws, (raw) =>
      raw.includes('"type":"view"'),
    );
    ws.send(JSON.stringify({ type: "watch", id: "cmd-watch-sec" }));
    await viewReady;

    const finalViewPromise = waitForMessage(
      ws,
      (raw) => raw.includes('"type":"view"') && raw.includes("Draft rejected."),
    );
    ws.send(
      JSON.stringify({
        type: "submit",
        id: "cmd-submit-sec",
        input: "Create a draft.",
      }),
    );
    const finalView = await finalViewPromise;
    expect(finalView).toContain(
      "Gmail draft headers must not contain line breaks.",
    );
    expect(personalStub()).toBeDefined();
    ws.close();
  });
});
