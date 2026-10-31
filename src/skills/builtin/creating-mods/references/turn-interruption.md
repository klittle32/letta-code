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
  foreground child work without exact turn ownership produce `incomplete`.
  Missing parent scope stays conservative.
- A request while paused at an approval dialog retires that exact dialog and
  resolves its logical owner. Untouched approvals become interrupted denials;
  real companion and precomputed results remain queued for legitimate recovery.
  Already-running tools retain their execution tickets instead.
  Pause admission captures recovery independently of React effects, so an accepted
  interruption still retires its original owner after a scope replacement. Only
  the current scope may mutate its approval UI. Recovery is retained for the
  host lifetime under the original agent/conversation and revalidated against
  that conversation's backend pending tool-call IDs on a later legitimate send.
  Real companion results replace matching eager-recovery denials. This is
  in-memory retention, not a durable TUI checkpoint across process restarts.
- Each logical turn emits one `turn_end`, including `cancelled` and `error`.
  Terminal events retain the original turn identity and do not await receipt
  settlement. Continuation effects are ignored for cancelled/error turns.
- Foreground children are stopped only when parent agent/conversation and an
  unsettled tool ticket identify this turn. Their per-child stop hooks and
  cancellation settlement remain tracked, including late registration while the
  ticket runs. Missing ownership/hooks or failed stops stay incomplete.
  Background children have independent threads and are untouched, as are children
  identified with another conversation or another turn's tool ticket.
- Restored approvals without an observed host turn have no turn handle.
- No remote-child cancellation protocol or listener/headless interruption API
  is introduced by this slice.
