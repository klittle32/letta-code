import { constants } from "node:fs";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ContextInbox,
  type ContextInboxScope,
  createContextInbox,
} from "@/agent/context-inbox";
import {
  type ApiContextSession,
  captureApiContextSession,
} from "@/backend/api/context-session";
import {
  APIBackend,
  type APIClient,
  type Backend,
  getBackend,
} from "@/backend/backend";

type SessionErrorCode =
  | "invalid-scope"
  | "invalid-directory"
  | "store-unavailable"
  | "unmatched-api-owner"
  | "session-changed"
  | "cancelled";
export class PassiveContextSessionError extends Error {
  constructor(readonly code: SessionErrorCode) {
    super(`Passive context session ${code.replaceAll("-", " ")}`);
  }
}
export interface PassiveContextSession {
  readonly scope: Readonly<ContextInboxScope>;
  readonly inbox: ContextInbox;
  readonly transport: ApiContextSession["transport"];
  /** Check before new recording/binding/dispatch. A failure says nothing about
   * acceptance of an earlier POST and never releases/migrates inbox records.
   */
  assertCurrent(options?: { signal?: AbortSignal | null }): Promise<void>;
}
interface DirectoryIdentity {
  lexical: string;
  canonical: string;
  dev: bigint;
  ino: bigint;
}

function exact(value: string): string {
  if (typeof value !== "string" || !value || value !== value.trim())
    throw new PassiveContextSessionError("invalid-scope");
  return value;
}
function checkAbort(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new PassiveContextSessionError("cancelled");
}
async function directoryIdentity(
  path: string,
  privateInbox = false,
): Promise<DirectoryIdentity> {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new PassiveContextSessionError(
      privateInbox ? "invalid-directory" : "store-unavailable",
    );
  try {
    const lexical = resolve(path);
    const canonical = await realpath(lexical);
    const info = await stat(canonical, { bigint: true });
    if (!info.isDirectory() || info.ino === 0n) throw new Error();
    await access(canonical, constants.R_OK | constants.W_OK | constants.X_OK);
    if (process.platform !== "win32") {
      // Also fail closed under privileged tests where access() bypasses mode bits.
      if ((info.mode & 0o700n) !== 0o700n) throw new Error();
      if (
        privateInbox &&
        ((info.mode & 0o077n) !== 0n ||
          (process.getuid && info.uid !== BigInt(process.getuid())))
      )
        throw new Error();
    }
    return { lexical, canonical, dev: info.dev, ino: info.ino };
  } catch {
    throw new PassiveContextSessionError(
      privateInbox ? "invalid-directory" : "store-unavailable",
    );
  }
}
async function assertDirectory(
  original: DirectoryIdentity,
  privateInbox = false,
): Promise<void> {
  try {
    const current = await directoryIdentity(original.lexical, privateInbox);
    if (
      current.canonical === original.canonical &&
      current.dev === original.dev &&
      current.ino === original.ino
    )
      return;
  } catch {
    /* Missing/inaccessible replacement is also a changed session. */
  }
  throw new PassiveContextSessionError("session-changed");
}

/** Private host factory; neither capture nor inbox recording starts inference.
 * Scope/transport/inbox are fixed for the handle's lifetime. Reacquire after a
 * failed fence; never transfer old prepared/uncertain bindings to the new scope.
 *
 * Local namespace = canonical transcript-store URL plus directory device/inode;
 * account "local-store" is a storage sentinel, never a provider/human account.
 * Aliases share a namespace, replacement stores do not. Directory fences detect
 * replacement at async boundaries; they are not an OS filesystem transaction.
 * Local reconciliation refuses a replaced/retargeted store, but may read the
 * original unchanged store after backend replacement. API reconciliation keeps
 * the captured endpoint/principal through the existing API-session owner.
 *
 * directory must be an explicit absolute host-private directory (0700 on POSIX).
 * Inbox operations retain that captured namespace; call assertCurrent before new
 * writes. Recovery inspection may use the original inbox after auth changes.
 * Custom API getBackend/getClient dependencies must describe the same owner.
 */
export async function capturePassiveContextSession(options: {
  agentId: string;
  conversationId: string;
  directory: string;
  getBackend?: () => Backend;
  getClient?: () => Promise<APIClient>;
  expectedOrganizationId?: string;
  signal?: AbortSignal;
}): Promise<PassiveContextSession> {
  const currentBackend = options.getBackend ?? getBackend;
  // Capture all caller-owned scope values and backend BEFORE the first await.
  const source = currentBackend();
  const agent = exact(options.agentId);
  const conversation = exact(options.conversationId);
  const directory = options.directory;
  const signal = options.signal;
  const clientOwner = options.getClient;
  const expectedOrganizationId = options.expectedOrganizationId;
  const storePath = source.localConversationStorageDir;
  const isApi = source instanceof APIBackend;
  if (isApi && Boolean(options.getBackend) !== Boolean(clientOwner))
    throw new PassiveContextSessionError("unmatched-api-owner");
  if (!isApi && (typeof storePath !== "string" || !isAbsolute(storePath)))
    throw new PassiveContextSessionError("store-unavailable");
  if (typeof directory !== "string" || !isAbsolute(directory))
    throw new PassiveContextSessionError("invalid-directory");
  checkAbort(signal);
  const requireBackend = () => {
    if (currentBackend() !== source)
      throw new PassiveContextSessionError("session-changed");
    return source;
  };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch {
    throw new PassiveContextSessionError("invalid-directory");
  }
  const inboxDirectory = await directoryIdentity(directory, true);
  requireBackend();
  const api = isApi
    ? await captureApiContextSession({
        getBackend: requireBackend,
        getClient: clientOwner,
        expectedOrganizationId,
        signal,
      })
    : undefined;
  const store =
    !isApi && storePath ? await directoryIdentity(storePath) : undefined;
  async function assertStore() {
    if (!store || source.localConversationStorageDir !== storePath)
      throw new PassiveContextSessionError("session-changed");
    await assertDirectory(store);
  }
  async function assertCurrent(request: { signal?: AbortSignal | null } = {}) {
    checkAbort(request.signal);
    requireBackend();
    await assertDirectory(inboxDirectory, true);
    if (api) await api.assertCurrent(request);
    else await assertStore();
    checkAbort(request.signal);
    requireBackend();
  }
  let principal: Pick<ContextInboxScope, "backend" | "account">;
  if (api) principal = api.scope;
  else if (store)
    principal = {
      backend: `local:${pathToFileURL(store.canonical).href}#${store.dev}:${store.ino}`,
      account: "local-store",
    };
  else throw new PassiveContextSessionError("store-unavailable");
  const scope = Object.freeze({ ...principal, agent, conversation });
  // One guard for captured local methods, not another execution/recovery engine.
  function guarded<Args extends unknown[], Result>(
    method: (...args: Args) => Promise<Result>,
    writing = false,
  ) {
    return async (...args: Args): Promise<Result> => {
      if (writing) await assertCurrent();
      else await assertStore();
      const result = await method(...args);
      await assertStore();
      return result;
    };
  }
  const transport =
    api?.transport ??
    Object.freeze({
      createConversationMessageStream: guarded(
        source.createConversationMessageStream.bind(source),
        true,
      ),
      listConversationMessages: guarded(
        source.listConversationMessages.bind(source),
      ),
      retrieveMessage: guarded(source.retrieveMessage.bind(source)),
      retrieveRun: guarded(source.retrieveRun.bind(source)),
      streamConversationMessages: guarded(
        source.streamConversationMessages.bind(source),
      ),
      streamRunMessages: guarded(source.streamRunMessages.bind(source)),
      cancelRun: guarded(source.cancelRun.bind(source), true),
    });
  await assertCurrent({ signal });
  return Object.freeze({
    scope,
    inbox: createContextInbox({ directory: inboxDirectory.canonical, scope }),
    transport,
    assertCurrent,
  });
}
