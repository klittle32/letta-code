# Trusted fresh-session activation (TUI)

Check `letta.capabilities.session?.activate` before calling
`ctx.session?.activate({ conversationId, workingDirectory, signal? })`.
Headless and listener hosts explicitly report false. This surface is available
to global mods in owned command/event/tool invocation contexts; an executing
tool cannot pass the idle gate.

Create the conversation separately, finish any model preparation, and durably
save its exact ID and destination before activation. The host accepts an unused
same-agent ID saved across mod reloads or backend restarts; there is no
process-local minted-ID requirement and activation never creates a replacement.

```ts
letta.commands.register({
  id: "activate-saved",
  description: "Activate a saved fresh conversation",
  run(ctx) {
    // Load your already-durable transition, including the exact created ID.
    void loadSavedTransition().then(({ conversationId, workingDirectory }) =>
      ctx.session?.activate({ conversationId, workingDirectory }),
    );
    return { type: "handled" };
  },
});
```

The host captures source scope and owner lifetime, holds an admission lock, and
requires idle execution, no approvals/results, no queued input, and no unsettled
source/target children of any kind. Actual local tool tickets from older
replaced turns also block activation. Unrelated child scopes do not block;
missing ownership stays conservative.

The host resolves the destination, applies workspace and cross-agent guards,
and asks a native Allow/Deny question identifying the mod, source, exact target,
and directory. Destination project settings and hooks are not loaded before
explicit trust. The question cancels on Escape, scope change, owner reload,
command timeout, or invocation/explicit signal abort. A successfully handled
command preserves its detached invocation lifetime.

After approval the host rechecks source generation, directory, target freshness,
and admission gates across awaits. Backend evidence must show the exact
same-agent target is unarchived, has no message-request timestamp, has empty
in-context IDs, and has no messages. Unknown evidence refuses activation.
These are observed freshness checks, not a distributed reservation against
another client submitting concurrently.

Activation reuses `/new` reset/session persistence/lifecycle behavior and `/cd`
cwd/settings behavior, preserving permission mode. It never resumes history,
recovers approvals, enqueues a prompt, or drains queued input. Bridge arrivals
during the transition are parked outside the send queue with their original
agent/conversation (unscoped arrivals retain the source scope). A transcript
notice shows their text and scope. Full payloads remain in memory for this TUI
lifetime; they are not automatically replayed, even on Enter or after a refusal.
This parking is not durable across exit and adds no recovery command.
Only source global mods are reloaded; there is no destination project-mod loader.

Results:

- `{ status: "refused", reason }`: no destination scope committed. A preparation
  failure reloads the source settings/cwd (or the current replacement
  scope if the original scope was independently superseded).
- `{ status: "activated", initialization: "pending", conversationId, workingDirectory }`: the exact scope
  and cwd were installed. Destination initialization is detached; failures are
  surfaced in the TUI without rolling back. The activation lock remains held
  until initialization finishes or its ten-second deadline expires. A deadline
  cancels a pending mod reload, fences late registrations, and restores input;
  initialization remains incomplete and is reported as such. `/reload` may be
  retried after fixing the mod. The receipt does not assert successful startup.

Do not depend on the old mod's post-activation continuation to save your ID.
Source teardown is scheduled after commit and is never awaited by the activation
promise itself. Session persistence uses the existing `/new` settings mechanism,
including its asynchronous disk-write behavior; this API does not add a durable
transaction or rollback of hooks, filesystem effects, or external work.

All fallible destination preparation and validation precede source close. Source
SessionEnd hooks still select the original cwd's cached settings. Only a
synchronous scope/admission check separates close from commit. Once source
close begins, hook side effects cannot be rolled back: a source hook error,
scope change during close, or synchronous chdir/commit failure may leave the
source active after some close handlers ran. A refusal does not claim those
handlers were undone. Detached JavaScript or external hook work that ignores
cancellation may keep running; the initialization deadline is a host admission
bound, not proof of physical process termination.
