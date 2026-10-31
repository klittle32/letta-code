import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@/backend/local/local-backend";
import { LocalStore } from "@/backend/local/local-store";
import { loadModConversationHistoryFromBackend } from "./conversation-history";

test("pages through real local history beyond the per-page cap, retaining the newest 4096 rows", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "mod-history-pagination-"));
  try {
    const agentId = "agent-local-paging";
    const store = new LocalStore(agentId, { storageDir });
    const conversation = store.createConversation({ agent_id: agentId });
    store.appendTurnInput(conversation.id, {
      messages: Array.from({ length: 4205 }, (_, index) => ({
        role: "user" as const,
        content: `Human row ${index}`,
        otid: `human-${index}`,
      })),
    });
    const backend = new LocalBackend({ storageDir, memfsEnabled: false });
    const scope = { agentId, conversationId: conversation.id };
    const collected: string[] = [];
    let before: string | undefined;
    let pages = 0;
    while (collected.length < 4096) {
      const page = await loadModConversationHistoryFromBackend(backend, scope, {
        limit: Math.min(500, 4096 - collected.length),
        order: "desc",
        before,
      });
      expect(page.length).toBeGreaterThan(0);
      expect(page.length).toBeLessThanOrEqual(500);
      expect(page[0]?.id).not.toBe(before);
      if (collected.length === 0) {
        expect(page[0]).toMatchObject({ otid: "human-4204" });
      }
      if (collected.length + page.length === 4096) {
        expect(page.at(-1)).toMatchObject({ otid: "human-109" });
      }
      for (const row of page) collected.push(row.id);
      before = page.at(-1)?.id;
      pages += 1;
    }
    expect(pages).toBe(9);
    expect(new Set(collected).size).toBe(4096);
    const afterOldest = await loadModConversationHistoryFromBackend(
      backend,
      scope,
      {
        after: before,
        order: "desc",
        limit: 500,
      },
    );
    expect(afterOldest.map((row) => row.id)).toEqual(collected.slice(0, 500));
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
});
