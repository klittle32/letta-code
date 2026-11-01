import { createHash } from "node:crypto";
import { join } from "node:path";
import { APIUserAbortError } from "@letta-ai/letta-client/core/error";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { ContextInboxInput } from "@/agent/context-inbox";
import { createPassiveContextAcceptance } from "@/agent/passive-context-acceptance";
import { composePassiveContextInput } from "@/agent/passive-context-input";
import { capturePassiveContextSession } from "@/agent/passive-context-session";
import { APIBackend, type Backend, getBackend } from "@/backend/backend";
import { isCloudApiShutdownRejection } from "@/utils/cloud-api-shutdown";
import { withFileLock } from "@/utils/file-lock";
import type { ContextPlacement } from "./context-inbox";
import { listContextInboxMetadata } from "./context-inbox-metadata";
import {
  contextNamespace,
  createContextPresentation,
  type HumanPresentationEntry,
} from "./context-presentation";
import type { ConversationMessageTransport } from "./message";
import { setMessageTransportOwner } from "./message-transport-owner";

// Transport aborts use the SDK class or the standard AbortError name. Keep this
// leaf check independent of tool execution/approval initialization.
function isTransportAbort(error: unknown): boolean {
  return (
    error instanceof APIUserAbortError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

type Scope = { agentId: string; conversationId: string };
/** Host-owned lazy inbox routing. No runtime, background work or unsolicited send. */
export function createPassiveContextHost(options: {
  directory: string;
  getBackend: () => Backend;
  capture?: typeof capturePassiveContextSession;
}) {
  const presentation = createContextPresentation();
  const sessions = new WeakMap<
    Backend,
    Map<string, ReturnType<typeof capturePassiveContextSession>>
  >();
  function directory(scope: Scope) {
    const key = createHash("sha256")
      .update(JSON.stringify(scope))
      .digest("hex");
    return join(options.directory, key);
  }
  function session(
    scope: Scope,
    backend = options.getBackend(),
    fresh = false,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (
      !options.capture &&
      backend instanceof APIBackend &&
      backend !== getBackend()
    )
      throw new Error("Unmatched API context owner");
    if (options.getBackend() !== backend)
      throw new Error("Context backend changed");
    let entries = sessions.get(backend);
    if (!entries) {
      entries = new Map();
      sessions.set(backend, entries);
    }
    const key = directory(scope);
    let pending = fresh ? undefined : entries.get(key);
    if (!pending) {
      // Default capture owns the real API principal; injected local capture is
      // useful in deterministic hosts without replacing the message path.
      pending = (options.capture ?? capturePassiveContextSession)({
        ...scope,
        directory: key,
        signal,
        ...(options.capture || backend.localConversationStorageDir
          ? { getBackend: options.getBackend }
          : {}),
      });
      entries.set(key, pending);
      const capturedEntries = entries;
      const entry = pending;
      void pending.catch(() => {
        if (capturedEntries.get(key) === entry) capturedEntries.delete(key);
      });
    }
    return pending;
  }
  async function currentSession(
    scope: Scope,
    backend: Backend,
    signal?: AbortSignal | null,
  ) {
    let source = await session(scope, backend, false, signal ?? undefined);
    try {
      await source.assertCurrent({ signal });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "session-changed"
      )
        throw error;
      // Reacquire only for NEW work. Old handles/streams retain their exact
      // captured principal and inbox, including all uncertain submissions.
      source = await session(scope, backend, true, signal ?? undefined);
    }
    return source;
  }
  function context(scope: Scope, signal?: AbortSignal) {
    scope = { ...scope };
    const backend = options.getBackend();
    // The handle captures lazily once, then always inspects/reconciles its
    // original namespace even after the ambient account/backend changes.
    let original: ReturnType<typeof session> | undefined;
    function captured() {
      signal?.throwIfAborted();
      original ??= session(scope, backend, true, signal);
      return original;
    }
    return {
      async record(input: ContextInboxInput) {
        const frozen = structuredClone(input);
        const source = await captured();
        await source.assertCurrent({ signal });
        signal?.throwIfAborted();
        let placement: ContextPlacement | undefined;
        if (frozen.visibility !== "model") {
          presentation.authorize(source.scope, backend);
          placement = presentation.boundary(source.scope, backend);
          if (!placement) {
            const excluded = new Set(
              (await source.inbox.listSubmissions()).map(
                (s) => s.contextMessageOtid,
              ),
            );
            const page = await source.transport.listConversationMessages(
              scope.conversationId,
              {
                order: "desc",
                limit: 100,
                ...(scope.conversationId === "default"
                  ? { agent_id: scope.agentId }
                  : {}),
              },
              { signal },
            );
            const row = page
              .getPaginatedItems()
              .find(
                (r) =>
                  r.id &&
                  [
                    "user_message",
                    "assistant_message",
                    "reasoning_message",
                    "tool_call_message",
                    "approval_request_message",
                  ].includes(r.message_type ?? "") &&
                  !(
                    r.message_type === "user_message" &&
                    r.otid &&
                    excluded.has(r.otid)
                  ),
              );
            const tool =
              row &&
              (row.message_type === "tool_call_message" ||
                row.message_type === "approval_request_message")
                ? "tool_calls" in row && Array.isArray(row.tool_calls)
                  ? row.tool_calls.at(-1)
                  : row.tool_call
                : undefined;
            placement = row
              ? {
                  after: {
                    messageId: row.id,
                    ...(tool?.tool_call_id
                      ? { toolCallId: tool.tool_call_id }
                      : {}),
                    ...("otid" in row && row.otid ? { otid: row.otid } : {}),
                  },
                }
              : page.getPaginatedItems().length === 0
                ? { after: null }
                : undefined;
          }
          await source.assertCurrent({ signal });
        }
        signal?.throwIfAborted();
        const record = await source.inbox.record(frozen, placement);
        if (frozen.visibility !== "model")
          presentation.invalidate(source.scope, backend);
        return record;
      },
      async list() {
        return (await captured()).inbox.list();
      },
      async submissions() {
        return (await captured()).inbox.listSubmissions();
      },
      async reconcile(id: string) {
        const source = await captured();
        const binding = await withFileLock(
          join(directory(scope), "dispatch.lock"),
          async () => {
            const value = await source.inbox.getSubmission(id);
            return value?.outcome === "prepared"
              ? source.inbox.settleSubmission(id, "rejected")
              : value;
          },
          { signal, reapOnlyDeadOwner: true },
        );
        if (!binding || binding.outcome !== "uncertain") return binding;
        const acceptance = createPassiveContextAcceptance(binding);
        let after: string | undefined;
        while (true) {
          const page = await source.transport.listConversationMessages(
            scope.conversationId,
            {
              order: "asc",
              limit: 100,
              ...(after ? { after } : {}),
              ...(scope.conversationId === "default"
                ? { agent_id: scope.agentId }
                : {}),
            },
            { signal },
          );
          const rows = page.getPaginatedItems();
          for (const row of rows) {
            signal?.throwIfAborted();
            if (acceptance.observe(row))
              return source.inbox.settleSubmission(id, "accepted");
          }
          const cursor = rows.at(-1)?.id;
          if (rows.length < 100) break;
          if (!cursor || cursor === after)
            throw new Error("Context history cursor did not advance");
          after = cursor;
        }
        return binding;
      },
    };
  }
  return {
    context,
    subscribeHuman(
      scope: Scope,
      boundary: () => ContextPlacement | undefined,
      notify: () => void,
    ) {
      return presentation.subscribe(
        scope,
        options.getBackend(),
        boundary,
        notify,
      );
    },
    async assertHumanCurrent(scope: Scope, id: string, signal?: AbortSignal) {
      const backend = options.getBackend();
      const source = await currentSession(scope, backend, signal);
      if (!id.startsWith(`context:${contextNamespace(source.scope)}:`))
        throw new Error("Context principal changed");
      await source.assertCurrent({ signal });
    },
    async humanSnapshot(
      scope: Scope,
      signal?: AbortSignal,
    ): Promise<HumanPresentationEntry[]> {
      const backend = options.getBackend();
      const metadata = await listContextInboxMetadata(options.directory, scope);
      if (!metadata.some((entry) => entry.hasHuman)) return [];
      const source = await currentSession(scope, backend, signal);
      const entries = await source.inbox.humanEntries();
      await source.assertCurrent({ signal });
      if (options.getBackend() !== backend)
        throw new Error("Context backend changed");
      presentation.authorize(source.scope, backend);
      const namespace = contextNamespace(source.scope);
      return entries.map((entry) => ({
        ...entry,
        id: `context:${namespace}:${createHash("sha256").update(entry.record.id).digest("hex")}`,
      }));
    },
    /** Human transcript/reflection projection only; raw backend/mod history stays canonical. */
    async projectMessages(
      scope: { agentId?: string; conversationId: string },
      messages: Message[],
    ) {
      const metadata = await listContextInboxMetadata(options.directory, scope);
      const identities = new Set(
        metadata.flatMap((entry) => entry.contextOtids),
      );
      return messages.filter(
        (message) =>
          message.message_type !== "user_message" ||
          !message.otid ||
          !identities.has(message.otid),
      );
    },
    async transport(
      scope: Scope,
      humanOtid?: string,
      signal?: AbortSignal | null,
    ): Promise<ConversationMessageTransport> {
      if (signal?.aborted) throw new APIUserAbortError();
      const backend = options.getBackend();
      if (!humanOtid) return backend;
      scope = { ...scope };
      // Local snapshots prove when no records need delivery, including after
      // restart. Classification never needs live auth/session metadata.
      const metadata = await listContextInboxMetadata(options.directory, scope);
      if (
        !metadata.some(
          (entry) =>
            entry.hasPending || entry.submissionIds.includes(humanOtid),
        )
      )
        return backend;
      const source = await currentSession(scope, backend, signal).catch(
        (error) => {
          if (signal?.aborted && !isTransportAbort(error)) {
            const aborted = new APIUserAbortError();
            aborted.cause = error;
            throw aborted;
          }
          throw error;
        },
      );
      const existing = await source.inbox.getSubmission(humanOtid);
      const records = await source.inbox.list("model");
      const submissions = await source.inbox.listSubmissions();
      const reserved = new Set(
        submissions
          .filter((s) => s.outcome === "uncertain" || s.outcome === "accepted")
          .flatMap((s) => s.records.map((r) => r.id)),
      );
      if (!existing && !records.some((record) => !reserved.has(record.id)))
        return backend;
      const transport: ConversationMessageTransport = {
        async createConversationMessageStream(
          conversationId,
          body,
          requestOptions,
        ) {
          try {
            if (conversationId !== scope.conversationId)
              throw new Error("Context conversation changed");
            await source.assertCurrent({ signal: requestOptions?.signal });
            const request = structuredClone(body);
            if (!request.messages)
              throw new Error("Explicit human identity missing");
            const messages = request.messages;
            const index = messages.findIndex((m) => m.otid === humanOtid);
            const human = messages[index];
            if (
              !human ||
              !("role" in human) ||
              human.role !== "user" ||
              messages.filter((m) => m.otid === humanOtid).length !== 1
            )
              throw new Error("Explicit human identity missing");
            const prepared = await withFileLock(
              join(directory(scope), "dispatch.lock"),
              async () => {
                for (const previous of await source.inbox.listSubmissions()) {
                  if (
                    previous.id !== humanOtid &&
                    previous.outcome === "prepared"
                  )
                    await source.inbox.settleSubmission(
                      previous.id,
                      "rejected",
                    );
                }
                const prepared = await composePassiveContextInput({
                  inbox: source.inbox,
                  input: [human],
                  provenance: { kind: "human", userOtid: humanOtid },
                  requestFingerprint: createHash("sha256")
                    .update(JSON.stringify(request))
                    .digest("hex"),
                });
                if (prepared.kind !== "prepared")
                  throw new Error(
                    "Context submission requires reconciliation or a new submission ID",
                  );
                messages.splice(index, 1, ...prepared.input);
                try {
                  await source.assertCurrent({
                    signal: requestOptions?.signal,
                  });
                } catch (error) {
                  await source.inbox.settleSubmission(
                    prepared.binding.id,
                    "rejected",
                  );
                  throw error;
                }
                await source.inbox.markDispatch(prepared.binding.id);
                return prepared;
              },
              {
                signal: requestOptions?.signal ?? undefined,
                reapOnlyDeadOwner: true,
              },
            );
            // Everything after this durable boundary is uncertain until canonical
            // evidence arrives. In particular, no catch releases these records.
            const stream = await source.transport
              .createConversationMessageStream(
                conversationId,
                request,
                requestOptions,
              )
              .catch(async (error) => {
                if (isCloudApiShutdownRejection(error)) {
                  await withFileLock(
                    join(directory(scope), "dispatch.lock"),
                    () => source.inbox.confirmNotAdmitted(prepared.binding.id),
                    { reapOnlyDeadOwner: true },
                  );
                  throw error;
                }
                const diagnostic = new Error(
                  `Passive context submission ${prepared.binding.id} is uncertain. Inspect conversation.context.submissions() and call conversation.context.reconcile("${prepared.binding.id}") through the original scoped handle before any redelivery. Automatic retry is fenced.`,
                );
                if (
                  isTransportAbort(error) ||
                  requestOptions?.signal?.aborted
                ) {
                  const aborted = new APIUserAbortError();
                  aborted.cause = diagnostic;
                  throw aborted;
                }
                throw diagnostic;
              });
            const acceptance = createPassiveContextAcceptance(prepared.binding);
            const iterator = stream[Symbol.asyncIterator].bind(stream);
            stream[Symbol.asyncIterator] = async function* () {
              const original = { [Symbol.asyncIterator]: iterator };
              for await (const row of original) {
                if (acceptance.observe(row))
                  await source.inbox.settleSubmission(
                    prepared.binding.id,
                    "accepted",
                  );
                if (
                  !(
                    row.message_type === "user_message" &&
                    "otid" in row &&
                    row.otid === prepared.binding.contextMessageOtid
                  )
                )
                  yield row;
              }
            };
            return stream;
          } catch (error) {
            if (requestOptions?.signal?.aborted && !isTransportAbort(error)) {
              const aborted = new APIUserAbortError();
              aborted.cause = error;
              throw aborted;
            }
            throw error;
          }
        },
      };
      const dispatch: ConversationMessageTransport = {
        async createConversationMessageStream(conversationId, body, request) {
          if (conversationId !== scope.conversationId)
            throw new Error("Captured context conversation changed");
          await source
            .assertCurrent({ signal: request?.signal })
            .catch((error) => {
              if (request?.signal?.aborted) {
                const aborted = new APIUserAbortError();
                aborted.cause = error;
                throw aborted;
              }
              throw error;
            });
          return source.transport
            .createConversationMessageStream(conversationId, body, request)
            .catch((error) => {
              if (isCloudApiShutdownRejection(error) || isTransportAbort(error))
                throw error;
              if (request?.signal?.aborted) throw new APIUserAbortError();
              throw new Error(
                `Captured passive-context turn ${humanOtid} has an uncertain continuation. Automatic retry is fenced; inspect the original submission before recovery.`,
              );
            });
        },
      };
      setMessageTransportOwner(dispatch, backend, source.transport, dispatch);
      setMessageTransportOwner(transport, backend, source.transport, dispatch);
      return transport;
    },
  };
}
export type PassiveContextHost = ReturnType<typeof createPassiveContextHost>;
