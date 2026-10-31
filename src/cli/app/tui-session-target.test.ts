import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicPongExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { validateFreshTuiConversation } from "./tui-session-target";

test("accepts the exact persisted fresh same-agent ID after backend restart; rejects used and wrong-agent targets", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "activation-target-"));
  const options = {
    storageDir,
    memfsEnabled: false,
    executor: new DeterministicPongExecutor(),
  };
  try {
    const first = new LocalBackend(options);
    const agent = await first.createAgent({
      name: "Activation fixture",
      model: "openai/test",
    });
    const conversation = await first.createConversation({ agent_id: agent.id });
    await validateFreshTuiConversation(first, agent.id, conversation.id);
    const restarted = new LocalBackend(options);
    await validateFreshTuiConversation(restarted, agent.id, conversation.id);
    await expect(
      validateFreshTuiConversation(restarted, "wrong-agent", conversation.id),
    ).rejects.toThrow();
    const stream = await restarted.createConversationMessageStream(
      conversation.id,
      { messages: [{ role: "user", content: "probe" }] },
    );
    for await (const _chunk of stream) {
    }
    await expect(
      validateFreshTuiConversation(restarted, agent.id, conversation.id),
    ).rejects.toThrow();
    const retrieve = restarted.retrieveConversation.bind(restarted);
    restarted.retrieveConversation = async (id) => ({
      ...(await retrieve(id)),
      last_message_at: null,
      in_context_message_ids: [],
    });
    await expect(
      validateFreshTuiConversation(restarted, agent.id, conversation.id),
    ).rejects.toThrow("messages");
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
