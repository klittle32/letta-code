# Fresh scoped conversation creation

Use `ctx.conversation.create({ inheritModel?, title? })` to create a fresh
conversation for the source handle's agent. It returns another scoped conversation
handle. Unlike `fork()`, it does not copy source history. It does not activate a
chat/workspace, send a prompt, recover approvals, drain queued work, or run host
lifecycle hooks.

```ts
const fresh = await ctx.conversation.create({
  inheritModel: true,
  title: "Prepared workspace",
});
// Persist fresh.id in your own durable operation state before any later switch.
// Creation alone does not activate this conversation or start inference.
```

Omit `inheritModel` to use ordinary fresh-agent defaults. Pass `true` to snapshot
the source conversation's effective model, settings, and explicit context-window
behavior without changing agent-wide configuration. Local settings merge and
Cloud settings replacement follow their respective backend semantics. `title`
is stored as the conversation summary.

The source agent, conversation, backend, and workspace are captured for the
operation. An invoking mod's scope must match its source handle. Invocation
cancellation is checked before creation and during preparation; an already
started create request is allowed to return its ID so that it can be recovered.

## Failure and recovery

- Treat creation as inert with respect to inference and activation, not as
  side-effect-free. Local backend creation may initialize memory storage and
  compile/persist the system prompt.
- If creation returned an ID but subsequent preparation or cancellation failed,
  the error has `name: "ModConversationCreationError"`, `agentId`,
  `conversationId`, and `cause`. Retain that ID; do not blindly create another
  conversation. Inspect these public error fields rather than importing private
  host modules.
- A backend failure before returning an ID can leave creation status unknown,
  even if a record was persisted. Do not claim exactly-once creation or retry
  automatically through that uncertainty.
- Save a successful ID before any operation that may unload the invoking mod or
  change its scope. Do not rely on an old-runtime continuation to save it later.

This API does not provide trusted workspace activation. Keep activation separate
from creation, and do not approximate it with synthetic commands or private host
imports.
