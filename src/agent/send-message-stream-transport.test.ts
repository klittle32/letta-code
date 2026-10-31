import { expect, test } from "bun:test";
import Letta from "@letta-ai/letta-client";
import { captureApiContextSession } from "@/backend/api/context-session";
import { APIBackend } from "@/backend/backend";
import { prepareToolExecutionContextForSpecificTools } from "@/tools/manager";
import { sendMessageStreamWithBackend } from "./message";

test("dispatches through a principal-bound message transport without a full backend", async () => {
  const requests: {
    url: string;
    authorization: string | null;
    body: unknown;
  }[] = [];
  const client = new Letta({
    baseURL: "https://context.example",
    apiKey: "captured-test-key",
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("/v1/metadata/balance")) {
        return Response.json({ organization_id: "org-test-context" });
      }
      return new Response(
        'data: {"message_type":"stop_reason","stop_reason":"end_turn"}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const backend = new APIBackend({ getClient: async () => client });
  const session = await captureApiContextSession({
    getBackend: () => backend,
    getClient: async () => client,
  });
  // This assignment is a compile-time contract: no cast to a fictitious Backend.
  const transport: Parameters<typeof sendMessageStreamWithBackend>[0] =
    session.transport;
  const preparedToolContext = await prepareToolExecutionContextForSpecificTools(
    [],
    { runtimeContext: { mcpOriginatorSuperRunId: null } },
  );
  const stream = await sendMessageStreamWithBackend(
    transport,
    "conv-context-test",
    [{ role: "user", content: "Explicit human input", otid: "human-input-id" }],
    { preparedToolContext, skillSources: [], actingUserId: null },
  );
  for await (const _chunk of stream) {
    // Drain the real SDK stream; no provider or network is contacted.
  }
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    url: "https://context.example/v1/conversations/conv-context-test/messages",
    authorization: "Bearer captured-test-key",
    body: {
      messages: [
        {
          role: "user",
          content: "Explicit human input",
          otid: "human-input-id",
        },
      ],
    },
  });
  expect("forkConversation" in transport).toBe(false);
  expect("capabilities" in transport).toBe(false);
});
