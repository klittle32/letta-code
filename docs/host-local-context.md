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
`getHistory`. The TUI supports all three visibility values:

- `model`: the existing next-explicit-human model delivery, without a local human row.
- `human`: durable, labelled host-local collaborator context in the human transcript;
  never selected for model delivery.
- `both`: one local human row plus the existing frozen model delivery. Acceptance,
  uncertainty, retries and reconciliation do not duplicate the displayed row.

Human rows are not authored user messages or server history. Recording, rendering,
repainting and resume do not submit input or start inference. These rows stay outside
model/reflection buffers and title/description seeds. Assistant responses remain
unchanged even when they quote collaborator context.

A private placement commits atomically with the immutable record. Retrying an ID
preserves its original placement. Namespace-qualified row IDs and stable backend
message IDs/OTIDs and stable tool-call aliases determine positioning; `sequence` orders records at the same
boundary. Positioning is at whole-message boundaries, including an active message
when its stable identity is known, not at exact streamed fragments. Otherwise the
latest identifiable boundary (including the human OTID) is used. Without an active
UI boundary the captured transport reads one bounded page of canonical history
(up to 100 rows), skipping raw rows without a transcript counterpart, such as tool
returns. Stable tool-call IDs resolve live/resume aliases and parallel calls.
A genuinely empty history anchors at conversation start. A clipped, missing or legacy anchor is
labelled **boundary unavailable** before the loaded message tail; it is never
silently relocated to the tail's end. The stored anchor does not change when more
history or message aliases become available.

One active in-process TUI subscription installs before snapshot loading and receives
content-free invalidations after commit. Generation/workspace/backend changes fence
old asynchronous work; disposal removes the observer. Render-time API ownership
checks use an opaque memory-only configuration identity, with no client refresh,
auth lookup or filesystem work. Full captured-session/directory checks run before
installing a snapshot, on activation and on record invalidation. Same-owner reloads
retain the validated projection; unchanged/idempotent records cause no repaint.
A detected owner change hides old text immediately; a failed read replaces it with
the unavailable notice. Same-organization credential rotation recaptures and
revalidates the namespace; another organization never inherits the prior text.
There is no background monitoring of external credential/store mutation. The
credential owner's existing cache/reload behavior determines when external auth
changes become visible; directory fences still run for each newly loaded snapshot.
Explicit `/cd` retains the conversation's durable history: records gain no new workspace namespace. There is
no filesystem poller or cross-process live synchronization; another process's writes
appear on reactivation/restart. Ordinary conversations without human context perform
no additional principal capture for display.

Human text is loaded only from the exact currently authorized inbox. The cross-
namespace OTID classifier is not authority to expose text. Captured, still-current
sessions can read locally during metadata outages. Cold metadata failure displays a
context-unavailable notice while preserving the ordinary history/approval path.
Authorization failures remove projected text; changed principals/stores never inherit
records. Rendering strips terminal/OSC/control and selected bidi formatting characters at the
display boundary, retaining original stored bytes and literal markup.

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
snapshot can also force default titles/descriptions. Human projection displays an
unavailable notice on invalid snapshots rather than falling back to raw content.
There is no automatic repair
or retention policy for these files.

Record only consented collaborator content. Never put credentials, protected
memory, system instructions, policy or skill bodies into records. Inspection is
human-accessible local data, not permission to export protected host context.

Deterministic Linux/Bun tests exercise a rendered TUI, real mod command loading,
queue composition and an isolated local backend, plus original-stream acceptance
fixtures and original-scope history reconciliation. Human/both tests additionally
cover idle/in-tool/in-stream visibility, durable resume, whole-message aliases,
missing boundaries, scope/activation/disposal races and terminal-safe literal
rendering. Parent verification passed 606 tests across 79 isolated suites, all
13 static gates, and the rebuilt Node target. Independent re-review found no
blockers, including render-cost, identity rotation and tool-anchor corrections.

A continuous 59-second Linux desktop walkthrough exercised the rebuilt Node TUI
with a real scoped test mod and isolated deterministic local executor. It began
with no records or messages. Recording one note of each visibility produced three
local records and zero server rows; only human/both notes appeared. An automated
mod send produced two server rows without binding any context. Explicit human
input produced five rows total, with one accepted canonical context row containing
the model/both notes and no human-only marker. A later human-only note appeared
after the completed response without changing server history. Idempotent retries
and process restart preserved four records, five server rows and one accepted
binding. Dark live and light resumed projections were visually inspected, with
the three visible notes at their original whole-message boundaries and no
model-only bubble. Checkpoint assertions agreed with those counts. This is not
native proof of mid-stream/tool timing or live credential rotation; those paths
remain deterministic test evidence.

Prior model-only rebuilt Node native checks include the retained resume case and
a continuous fresh-conversation walkthrough:
recording alone leaves zero server rows; an automated mod send creates two rows
without consuming the record; human input adds exactly one context row, one human
row and one assistant row. Reconciliation confirms acceptance without adding rows,
and restart preserves all five raw rows while hiding the model-only bubble.
Dark and light projections were inspected. These checks use the deterministic
local executor and a literal fake model-catalog key; no provider call is verified.
They do not verify Cloud, Desktop, headless/listener orchestration, live Delta or
multiple computers.
