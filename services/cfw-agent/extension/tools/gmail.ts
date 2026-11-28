import { Buffer } from "node:buffer";

import {
  callConnector,
  type ConnectorBridgeEnv,
  readRunInput,
} from "../connections/google.ts";

export default {
  async fetch(request: Request, env: ConnectorBridgeEnv): Promise<Response> {
    const input = await readRunInput(request);
    if (!input || typeof input.action !== "string") {
      return Response.json(
        { error: "Missing Gmail action input." },
        { status: 400 },
      );
    }
    switch (input.action) {
      case "search": {
        if (typeof input.query !== "string") {
          return Response.json(
            { error: "Missing Gmail search query." },
            { status: 400 },
          );
        }
        const rawMax =
          typeof input.maxResults === "number" ? input.maxResults : 10;
        const params = new URLSearchParams({
          q: input.query,
          maxResults: String(Math.max(1, Math.min(rawMax, 25))),
        });
        return callConnector(
          env,
          "gmail",
          `/users/me/messages?${params.toString()}`,
        );
      }
      case "get_message":
        if (typeof input.messageId !== "string") {
          return Response.json(
            { error: "Missing Gmail messageId." },
            { status: 400 },
          );
        }
        return callConnector(
          env,
          "gmail",
          `/users/me/messages/${encodeURIComponent(input.messageId)}`,
        );
      case "create_draft": {
        if (
          typeof input.to !== "string" ||
          typeof input.subject !== "string" ||
          typeof input.body !== "string"
        ) {
          return Response.json(
            { error: "Missing Gmail draft fields (to, subject, body)." },
            { status: 400 },
          );
        }
        const rawMime = [
          `To: ${input.to}`,
          `Subject: ${input.subject}`,
          "Content-Type: text/plain; charset=UTF-8",
          "",
          input.body,
        ].join("\r\n");
        const raw = Buffer.from(rawMime, "utf8").toString("base64url");
        return callConnector(env, "gmail", "/users/me/drafts", {
          method: "POST",
          body: JSON.stringify({ message: { raw } }),
        });
      }
      default:
        return Response.json(
          { error: "Unsupported Gmail action." },
          { status: 400 },
        );
    }
  },
};
