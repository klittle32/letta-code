import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readContextInboxMetadata } from "./context-inbox";

type Scope = { agentId?: string; conversationId: string };
/** Local exclusion identities only, across original namespaces. This neither
 * exposes record content nor authorizes selecting/delivering any namespace. */
export async function listContextInboxMetadata(root: string, scope: Scope) {
  async function entries(directory: string) {
    try {
      return await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  const directories = scope.agentId
    ? [
        createHash("sha256")
          .update(
            JSON.stringify({
              agentId: scope.agentId,
              conversationId: scope.conversationId,
            }),
          )
          .digest("hex"),
      ]
    : (await entries(root)).filter((name) => /^[a-f0-9]{64}$/.test(name));
  const result: Awaited<ReturnType<typeof readContextInboxMetadata>>[] = [];
  for (const directory of directories) {
    const path = join(root, directory);
    for (const filename of await entries(path)) {
      if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
      const metadata = await readContextInboxMetadata(path, filename);
      const expected = createHash("sha256")
        .update(
          JSON.stringify({
            agentId: metadata.scope.agent,
            conversationId: metadata.scope.conversation,
          }),
        )
        .digest("hex");
      if (expected !== directory)
        throw new Error("Context inbox host scope mismatch");
      if (
        metadata.scope.conversation === scope.conversationId &&
        (!scope.agentId || metadata.scope.agent === scope.agentId)
      )
        result.push(metadata);
    }
  }
  return result;
}
