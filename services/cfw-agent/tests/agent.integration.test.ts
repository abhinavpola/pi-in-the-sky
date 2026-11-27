import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ServerMessage } from "../src/protocol";
import type { TestPersonalAgent } from "./worker";

const AUTH_HEADERS = {
  Authorization: "Bearer test-secret-token",
};

function stubFor(id: string): DurableObjectStub<TestPersonalAgent> {
  return env.PersonalAgent.getByName(
    id,
  ) as unknown as DurableObjectStub<TestPersonalAgent>;
}

function nextSocketMessage(
  ws: WebSocket,
  predicate: (message: ServerMessage) => boolean,
  label = "message",
  timeoutMs = 5_000,
): Promise<ServerMessage> {
  const seen: string[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(
        new Error(
          `Timed out waiting for ${label}. Seen: ${JSON.stringify(seen)}`,
        ),
      );
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      const raw = String(event.data);
      const parsed = JSON.parse(raw) as ServerMessage;
      seen.push(raw.slice(0, 220));
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(parsed);
      }
    };

    ws.addEventListener("message", onMessage);
  });
}

describe("cfw-agent workerd integration", () => {
  it("enforces bearer auth and exposes health endpoint", async () => {
    const health = await SELF.fetch("https://agent.test/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const unauthorized = await SELF.fetch(
      "https://agent.test/api/agents/auth-check/profile",
    );
    expect(unauthorized.status).toBe(401);

    const authorized = await SELF.fetch(
      "https://agent.test/api/agents/auth-check/profile",
      { headers: AUTH_HEADERS },
    );
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ entries: [] });
  });

  it("runs the full trip-planning workflow with memory, skills, connectors, browser, durable approval, and websockets", async () => {
    const agentId = "trip-e2e";
    const stub = stubFor(agentId);

    const profileRes = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/profile`,
      {
        method: "PUT",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ key: "home_airport", value: "SFO" }),
      },
    );
    expect(profileRes.status).toBe(200);

    const noteRes = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/notes`,
      {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "travel",
          content: "Loved staying near Shibuya on the last Tokyo trip.",
          date: "2026-10-15",
        }),
      },
    );
    expect(noteRes.status).toBe(201);

    await stub.setScriptedTurns([
      {
        toolCalls: [
          {
            id: "tc-1",
            name: "load_skill",
            arguments: { name: "flight-planning" },
          },
          {
            id: "tc-2",
            name: "memory_get_profile",
            arguments: {},
          },
          {
            id: "tc-3",
            name: "memory_search",
            arguments: { query: "Tokyo" },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-4",
            name: "gmail_search",
            arguments: { query: "flight receipt", maxResults: 5 },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-5",
            name: "gmail_get_message",
            arguments: { messageId: "msg-tokyo-2025" },
          },
          {
            id: "tc-6",
            name: "calendar_list_events",
            arguments: {
              timeMin: "2026-12-10T00:00:00Z",
              timeMax: "2026-12-20T00:00:00Z",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-7",
            name: "browser_navigate",
            arguments: {
              url: "https://flights.example/search?from=SFO&to=NRT",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-8",
            name: "browser_snapshot",
            arguments: {},
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-9",
            name: "request_approval",
            arguments: {
              action: "book_flight",
              summary: "Book ANA NH7 SFO->NRT Dec 12-19 ($980)",
              details: "Nonstop window seat 14A, total $980",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "tc-10",
            name: "memory_write_note",
            arguments: {
              category: "travel",
              content: "Approved ANA NH7 SFO->NRT Dec 12-19 for $980.",
            },
          },
        ],
      },
      {
        text: "Your Tokyo trip (ANA NH7 SFO->NRT Dec 12-19, $980) is approved and logged.",
      },
    ]);

    const wsResponse = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/ws`,
      {
        headers: {
          ...AUTH_HEADERS,
          Upgrade: "websocket",
        },
      },
    );
    expect(wsResponse.status).toBe(101);
    const ws = wsResponse.webSocket;
    expect(ws).toBeDefined();
    if (!ws) {
      throw new Error("Expected WebSocket");
    }

    const helloPromise = nextSocketMessage(ws, (m) => m.type === "hello");
    ws.accept();
    const hello = await helloPromise;
    expect(hello.type).toBe("hello");

    const viewPromise = nextSocketMessage(ws, (m) => m.type === "view");
    ws.send(JSON.stringify({ type: "watch", id: "watch-1" }));
    await viewPromise;

    const approvalPromise = nextSocketMessage(
      ws,
      (m) => m.type === "approval_requested",
    );
    const submitResult1Promise = nextSocketMessage(
      ws,
      (m) => m.type === "result" && m.id === "sub-1",
    );
    ws.send(
      JSON.stringify({
        type: "submit",
        id: "sub-1",
        operationId: "op-trip-1",
        input:
          "Find my last trip in Gmail and plan the same trip for next month.",
      }),
    );
    const submitResult1 = await submitResult1Promise;
    expect(submitResult1.type).toBe("result");
    if (submitResult1.type === "result") {
      expect(submitResult1.result).toMatchObject({
        operationId: "op-trip-1",
        accepted: true,
      });
    }

    const submitResult2Promise = nextSocketMessage(
      ws,
      (m) => m.type === "result" && m.id === "sub-2",
    );
    ws.send(
      JSON.stringify({
        type: "submit",
        id: "sub-2",
        operationId: "op-trip-1",
        input:
          "Find my last trip in Gmail and plan the same trip for next month.",
      }),
    );
    const submitResult2 = await submitResult2Promise;
    if (submitResult2.type === "result") {
      expect(submitResult2.result).toMatchObject({
        operationId: "op-trip-1",
        accepted: false,
      });
    }

    const approvalMsg = await approvalPromise;
    expect(approvalMsg.type).toBe("approval_requested");
    if (approvalMsg.type !== "approval_requested") {
      throw new Error("Expected approval_requested");
    }
    expect(approvalMsg.approval.action).toBe("book_flight");
    expect(approvalMsg.approval.status).toBe("pending");

    const resolveResultPromise = nextSocketMessage(
      ws,
      (m) => m.type === "result" && m.id === "approve-1",
    );
    ws.send(
      JSON.stringify({
        type: "resolve_approval",
        id: "approve-1",
        approvalId: approvalMsg.approval.id,
        approved: true,
        note: "Window seat confirmed",
      }),
    );
    const resolveResult = await resolveResultPromise;
    if (resolveResult.type === "result") {
      expect(resolveResult.result).toMatchObject({
        approvalId: approvalMsg.approval.id,
        status: "approved",
        delivered: "delivered",
      });
    }

    const settled = await stub.waitForOperation("op-trip-1");
    expect(settled.status).toBe("done");
    expect(settled.text).toContain("ANA NH7 SFO->NRT Dec 12-19, $980");

    const approvalsAfter = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/approvals?status=approved`,
      { headers: AUTH_HEADERS },
    );
    const approvalsJson = (await approvalsAfter.json()) as {
      approvals: Array<{ id: string; status: string; decisionNote: string }>;
    };
    expect(approvalsJson.approvals).toHaveLength(1);
    expect(approvalsJson.approvals[0]?.decisionNote).toBe(
      "Window seat confirmed",
    );

    const searchNotes = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/notes?q=NRT`,
      { headers: AUTH_HEADERS },
    );
    const searchJson = (await searchNotes.json()) as {
      notes: Array<{ content: string }>;
    };
    expect(searchJson.notes.some((n) => n.content.includes("ANA NH7"))).toBe(
      true,
    );

    const toolOutputs = await stub.getObservedToolOutputs();
    expect(toolOutputs.some((out) => out.includes("SFO"))).toBe(true);
    expect(toolOutputs.some((out) => out.includes("Shibuya"))).toBe(true);
    expect(toolOutputs.some((out) => out.includes("msg-tokyo-2025"))).toBe(
      true,
    );

    ws.close();
  });

  it("parks on browser takeover for MFA/sign-in and resumes via HTTP endpoint", async () => {
    const agentId = "browser-takeover-e2e";
    const stub = stubFor(agentId);

    await stub.setScriptedTurns([
      {
        toolCalls: [
          {
            id: "tc-takeover-1",
            name: "browser_request_takeover",
            arguments: {
              url: "https://airline.example/login",
              reason: "MFA verification required",
              liveViewUrl: "https://live.cloudflare.example/session/123",
            },
          },
        ],
      },
      {
        text: "Sign-in confirmed. Continuing with reservation.",
      },
    ]);

    const wsResponse = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/ws`,
      {
        headers: {
          ...AUTH_HEADERS,
          Upgrade: "websocket",
        },
      },
    );
    const ws = wsResponse.webSocket!;
    const takeoverPromise = nextSocketMessage(
      ws,
      (m) => m.type === "takeover_requested",
    );
    ws.accept();

    const submitRes = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/prompt`,
      {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Log in to the airline portal",
          operationId: "op-takeover-1",
          async: true,
        }),
      },
    );
    expect(submitRes.status).toBe(202);

    const takeoverMsg = await takeoverPromise;
    expect(takeoverMsg.type).toBe("takeover_requested");
    if (takeoverMsg.type !== "takeover_requested") {
      throw new Error("Expected takeover_requested");
    }
    expect(takeoverMsg.takeover.liveViewUrl).toBe(
      "https://live.cloudflare.example/session/123",
    );

    const resumeRes = await SELF.fetch(
      `https://agent.test/api/agents/${agentId}/takeovers/${encodeURIComponent(takeoverMsg.takeover.id)}/resume`,
      {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ note: "MFA completed" }),
      },
    );
    expect(resumeRes.status).toBe(200);
    expect(await resumeRes.json()).toMatchObject({
      takeoverId: takeoverMsg.takeover.id,
      delivered: "delivered",
    });

    const settled = await stub.waitForOperation("op-takeover-1");
    expect(settled.status).toBe("done");
    expect(settled.text).toContain("Sign-in confirmed");

    ws.close();
  });
});
