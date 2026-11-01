# Host-local context records (TUI)

`letta.capabilities.context?.record === true` enables `ctx.conversation.context`
on scoped mod command/event handles. Other hosts omit or deny this capability.
It is currently advertised only by the interactive TUI.

```ts
const context = ctx.conversation.context;
if (!context) throw new Error("Host-local context is unavailable");
await context.record({ id: "producer:item:1", text: "Collaborator activity", visibility: "model" });
const records = await context.list();
const submissions = await context.submissions();
await context.reconcile("original-human-otid");
```

`record` persists an immutable, idempotent host-local record without inference.
Reusing an ID with different text/visibility fails. `list` inspects host
records; it does not manufacture server `Message` rows and is separate from
`getHistory`. Only `model` visibility is supported. `human` and `both` fail
explicitly because durable human-visible context insertion is unsupported. This
API is therefore a passive model-context slice, not complete human/model
transcript parity.

Only native explicit human submissions, including human input queued after a
tool turn, select pending records. Notifications, cron, approvals, tool
continuations, synthetic user-role messages, and mod `sendMessageStream` do not.
Selection and context/human identities are frozen under the human's stable OTID.
The hash covers the fully normalized request body (including reminders, tools,
skills and request options in that body) before adding the immutable context
message; the frozen binding determines those added bytes. Protected request
content is hashed, never copied into records. Changed requests cannot reuse an
identity. The captured session transport is passed through
`sendMessageStreamWithBackend` and owns final dispatch and recovery reads.

Uncertainty is persisted before dispatch. Only positive canonical input rows
from that original stream or chronological history through its captured
transport establish acceptance. ACKs, terminal events, missing rows, timeout and
abort do not. Ambiguous dispatches are never automatically replayed or released.
User cancellation retains its abort classification so Esc parks queued human
input under the normal queue contract; a post-dispatch abort keeps its uncertain
binding and inspection diagnostic. Only the existing positively typed
`cloud_api_shutting_down` / `admitted:false` contract permits an exact-body
retry. Generic 409/429/503, network failures and aborts remain uncertain;
automatic approval rebuild/replay is fenced. Prepared bindings that never
crossed dispatch can be released under the dispatch lock by `reconcile` or the
next human submission. `submissions` and `reconcile` retain the original
namespace after a session switch; newer scopes never inherit its records. A
stale handle refuses new recording; reacquire a scoped handle for new work. New
work refreshes a rotated session without moving old uncertain bindings. Owner
disposal and invocation cancellation revoke operations.

Storage is host-local under the product config directory, namespaced by captured
backend/account/agent/conversation and local-store identity. Ordinary inputs in
a conversation without an inbox perform only a local check for durable namespace
data, with no extra auth, metadata or network lookup. Accepted-only or reserved-
only records do not require principal lookup for a new ordinary submission when
no context is pending. Pending context still requires the captured principal
checks before delivery. Initialization and recovery are lazy; there are no
watchers or background inference. Records have no retention policy. As with
ContextInbox, atomic snapshots cover process crashes, not power loss.

Model-only canonical context rows are excluded from human resume/backfill,
reflection, and title/description seeds by their persisted source OTIDs, never
by matching text. Classification reads validated atomic local inbox snapshots
without live auth/metadata, so a metadata outage cannot erase the history tail
or pending approvals. This read-only exclusion uses identities from original
namespaces without exporting their text, selecting records, or moving them to
the current principal. Assistant responses remain unchanged, including responses
that quote context. Raw backend history and mod `getHistory` retain those server
rows and are separate from the human projection. Recovery reads and stream
resumes use the captured transport. Cancellation uses a proven exact run ID on
that transport; without one, cancellation reports unsupported rather than
retargeting a conversation on another principal.

Corrupt or unreadable snapshots fail closed. A bad namespace in the current
conversation can block human sends and make projected resume history unavailable;
pending approvals still have the separate retrieval fallback. Title/description
classification without an agent ID scans inbox directories, so an unrelated bad
snapshot can also force default titles/descriptions. There is no automatic repair
or retention policy for these files.

Record only consented collaborator content. Never put credentials, protected
memory, system instructions, policy or skill bodies into records. Inspection is
human-accessible local data, not permission to export protected host context.

Deterministic Linux/Bun tests exercise a rendered TUI, real mod command loading,
queue composition and an isolated local backend, plus original-stream acceptance
fixtures and original-scope history reconciliation. Rebuilt Node native checks
include the retained resume case and a continuous fresh-conversation walkthrough:
recording alone leaves zero server rows; an automated mod send creates two rows
without consuming the record; human input adds exactly one context row, one human
row and one assistant row. Reconciliation confirms acceptance without adding rows,
and restart preserves all five raw rows while hiding the model-only bubble.
Dark and light projections were inspected. These checks use the deterministic
local executor and a literal fake model-catalog key; no provider call is verified.
They do not verify Cloud, Desktop, headless/listener orchestration, live Delta or
multiple computers.
