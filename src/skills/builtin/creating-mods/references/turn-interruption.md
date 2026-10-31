# Exact-turn interruption (TUI)

Check `letta.capabilities.turn?.interrupt` before using `ctx.turn`. Headless and
listener hosts explicitly report this capability as false. Idle contexts have
no turn handle. A handle contains `id`, `agentId`, `conversationId`, and
`requestInterrupt(reason?)`.

Capture the handle when installing a watcher. It belongs to the observed logical
turn and the mod's activation generation. It survives streaming/tool/approval
continuations. It cannot target a later turn, and reload/disposal invalidates the
mod's captured handles. Local tool contexts retain their original turn identity.

```ts
letta.events.on("turn_start", (_event, ctx) => {
  const turn = ctx.turn;
  if (!turn) return;
  // Register with your existing watcher; dispose the watcher when appropriate.
  watcher.once("changed", async () => {
    const receipt = turn.requestInterrupt("Inputs changed");
    if (receipt.status !== "requested") return;
    const outcome = await receipt.wait(1000);
    if (outcome.status === "incomplete") {
      // Inspect pending resources and errors; do not claim work has stopped.
    }
  });
});
```

The request is synchronous. A turn hook may request interruption, but must return
without awaiting `completion` or `wait()`: that hook itself owns work the receipt
must wait for. Watcher callbacks outside that stack may await either.

A request returns `not-applied` for an inactive mod owner or stale turn. A requested
receipt has `completion` (host-observable settlement) and `wait(timeoutMs)` (a
bounded observation). A timeout does not discard tracking or force tools to stop.

The TUI fences new local tool starts before aborting the exact turn controller.
Signal-ignoring tools and their checkpoints remain tracked beyond the responsive
abort grace period. Checkpoint failures are reported in the receipt. Backend
cancellation uses only an ID observed on that turn's stream and then retrieves
that exact run. Its ID and agent must match, and its recorded status must be
completed, failed, or cancelled. An acknowledgement cannot override a still-running
record. A run that already ended can settle even if it rejects cancellation.
Normal approval/tool transitions retain the observed ID; new dispatches and
truncated/error streams invalidate it. It never guesses the latest run or falls
back to conversation cancellation. Ordinary Esc keeps its existing behavior.

This is a conservative boundary, not a universal stop guarantee:

- `settled` means the host owner unwound, tracked local tools/checkpoints settled,
  and any dispatched backend run was observed terminal. It does not promise
  termination of upstream provider compute or billing, or rollback of effects.
- Missing run IDs (including internally resumed streams without direct observation),
  agentless runs, rejected/unconfirmed cancellation, and active
  child work without exact turn ownership produce `incomplete`. Children known to
  belong to another parent conversation are excluded; missing parent scope stays
  conservative.
- A request while paused at an approval dialog fences execution but reports the
  unresolved approval owner as incomplete; it does not retire the dialog.
- Restored approvals without an observed host turn have no turn handle.
- No remote-child cancellation protocol or listener/headless interruption API
  is introduced by this slice.
