import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextInbox } from "./context-inbox";
import { listContextInboxMetadata } from "./context-inbox-metadata";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "context-metadata-"));
  roots.push(root);
  const scope = { agentId: "agent", conversationId: "conv" };
  const directory = join(
    root,
    createHash("sha256").update(JSON.stringify(scope)).digest("hex"),
  );
  const inbox = createContextInbox({
    directory,
    scope: {
      backend: "original",
      account: "original-account",
      agent: scope.agentId,
      conversation: scope.conversationId,
    },
  });
  await inbox.record({
    id: "r",
    text: "PRIVATE_RECORD_TEXT",
    visibility: "model",
  });
  return { root, scope, directory, inbox };
}
test("classification exposes only validated identities, not previous-principal record text", async () => {
  const f = await fixture();
  expect((await listContextInboxMetadata(f.root, f.scope))[0]?.hasPending).toBe(
    true,
  );
  const binding = await f.inbox.bindExplicitSubmission("human");
  await f.inbox.markDispatch("human");
  const uncertain = await listContextInboxMetadata(f.root, f.scope);
  expect(uncertain[0]?.contextOtids).toEqual([binding.contextMessageOtid]);
  expect(uncertain[0]?.hasPending).toBe(false);
  expect(JSON.stringify(uncertain)).not.toContain("PRIVATE_RECORD_TEXT");
  await f.inbox.settleSubmission("human", "accepted");
  expect(
    (await listContextInboxMetadata(f.root, { conversationId: "conv" }))[0]
      ?.hasPending,
  ).toBe(false);
  expect(
    await listContextInboxMetadata(f.root, {
      agentId: "other",
      conversationId: "conv",
    }),
  ).toEqual([]);
  expect(
    await listContextInboxMetadata(f.root, { conversationId: "other" }),
  ).toEqual([]);
});
test("corrupt source identities fail closed instead of exposing model-only rows", async () => {
  const f = await fixture();
  await f.inbox.bindExplicitSubmission("human");
  const filename = (await readdir(f.directory)).find((name) =>
    name.endsWith(".json"),
  );
  if (!filename) throw new Error("Missing snapshot");
  const state = JSON.parse(await readFile(join(f.directory, filename), "utf8"));
  state.submissions[0].contextMessageOtid = "not-a-host-uuid";
  await writeFile(join(f.directory, filename), JSON.stringify(state));
  await expect(listContextInboxMetadata(f.root, f.scope)).rejects.toThrow(
    "Corrupt context inbox",
  );
});
