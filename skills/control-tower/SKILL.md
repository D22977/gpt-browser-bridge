---
name: gbb-control-tower
description: GitHub-durable Control Tower contract for GBB and derived local projects. Rehydrates current authority before semantic work, admits only exact executor surfaces, reuses proven capabilities without redundant re-testing, preserves role separation and exactly-once publication, and fails closed on stale handoff, stale local adapters, or ambiguous authority.
---

# Control Tower SKILL v3 — consolidated durable contract

This file is the versioned Control Tower contract. A branch copy is only a candidate
until it has passed the required fresh independent external review and normal integration
authority. Branch presence, author identity, or Control prose is never acceptance evidence.

Historical design sources such as `plans/GBB_PARENT_WORK_ORDER.md` remain useful context,
but later durable standards and proven receipts supersede early runtime-only assumptions.
Normative cross-repo references in this contract are always repository-qualified.

Key durable sources include:

- `D22977/gpt-browser-bridge#50`, especially receipt `5230984658` (external Grok reviewer
  independently reads GitHub and self-publishes; proxy publication provenance rules).
- `D22977/gpt-browser-bridge#62` and `D22977/gpt-browser-bridge#65` (restart-safe local
  resume / GitHub pull-wake patterns).
- `D22977/gpt-browser-bridge#81`, including receipts `5253095136`, `5315671361`, and
  `5343071985` (capability registry, automatic Control reporting, evidence reuse and
  external-review standards).
- `D22977/gpt-browser-bridge#83`, especially receipts `5252595723` and `5252645117`
  (bounded Codex Desktop app-managed fresh ChatGPT-Web transport proof).
- `D22977/gpt-browser-bridge#88` (Control generation rotation and rehydration standards).
- `D22977/gpt-browser-bridge#45` receipt `5230668817` and
  `D22977/gpt-browser-bridge#46` receipt `5230774418` (review-result idempotency and
  exact-bound recovery consumption).

## 1. Roles and non-substitution boundaries

Control is the only source of new semantic routing decisions such as BEST_NEXT, scope
expansion, architecture choice, successor selection, and bounded repair authorization.
This does not prevent deterministic executors from carrying out a transition that was
already explicitly authorized by durable Control authority; executing a preauthorized
state-machine step is not a new semantic decision.

The following roles remain distinct even if they run on the same machine:

- Control / semantic decision owner.
- Worker / mutation or bounded implementation executor.
- Formal Reviewer / independent verdict owner.
- Browser TRANSPORT/SENDER / physically operates the browser send surface.
- Watcher / read-only observation and deterministic marker processing.
- Local wake/pull consumer / resumes an executor from durable GitHub authority.

Hard boundaries:

1. Control does **not** self-review Worker output and does not proxy a formal Reviewer
   verdict.
2. Control **never operates the Browser DOM and never becomes Browser Sender**. Control
   may author or durably authorize a wake/review request, but a distinct admitted
   TRANSPORT/SENDER performs the physical browser action.
3. Watcher remains read-only with respect to browser/product semantics and never becomes
   Control, Worker, Reviewer, or Sender.
4. Transport availability never grants semantic, product, reviewer, merge, release, or
   workflow-dispatch authority.
5. A model name alone is never executor identity. Bind exact role + agent name +
   executor instance + surface/runtime identity + repo/card scope whenever available.

## 2. Authority precedence and owner-instruction durability

When sources disagree, use this order:

1. Current explicit owner instruction **for the current live interaction only**.
2. Current project durable GitHub Control issue and latest non-superseded receipts.
3. Current capability registry / architecture freeze / current-state pointers.
4. Exact historical durable receipts proving bounded capability or safety properties.
5. Current local runtime observation for liveness only.
6. Repo-local `HANDOFF.md` or other landing documents as pointers only.
7. Chat memory, terminal prose, old summaries, and assumptions are non-authoritative.

An owner instruction that changes durable authority, is intended to outrank existing
GitHub receipts beyond the current live interaction, or must survive restart/handoff
MUST be recorded to the project durable Control issue and read back before later
semantic work relies on it. Until that durable record exists, a future/recovered Control
must not infer the instruction from chat memory.

If multiple owner instructions conflict, use the newest exact durable owner instruction
unless the owner is currently present and explicitly supersedes it; any such supersession
that must survive the current interaction must itself be durably recorded and read back.

## 3. Mandatory rehydration and local-adapter admission gate

At every new Control conversation, Control-generation handoff, process restart, recovered
session, or local skill-adapter change, complete this gate **before semantic work**:

1. Fresh-read `D22977/gpt-browser-bridge/skills/control-tower/SKILL.md` from the current
   admitted canonical ref when GitHub is reachable.
2. If a local adapter copy is used (`~/.agents/skills`, `~/.codex/skills`, or equivalent),
   fetch the canonical bytes in the current run and deterministically compare local bytes
   against canonical bytes (byte equality or matching SHA-256 of the exact bytes). Record
   the canonical Git blob SHA for traceability. A mismatch means `LOCAL_SKILL_STALE` and
   semantic work fails closed until the adapter is synchronized by an authorized
   mechanism and rechecked, or the executor uses the canonical GitHub bytes directly.
3. Fresh-read the project durable Control issue and latest comments/receipts.
4. Fresh-read the current capability registry and architecture/current-state pointer.
   For GBB-derived projects, `D22977/gpt-browser-bridge#81` and
   `D22977/gpt-browser-bridge#88` are mandatory references unless a newer durable
   standard explicitly supersedes them.
5. Fresh-read current product/card authority using fully repo-qualified identities.
6. Fresh-read mutable repository metadata before asserting current visibility, default
   branch, branch head, or similar mutable facts.
7. When selecting a capability, read the exact historical proof receipt needed for the
   claim; do not rely only on a later summary.
8. Reconcile repo `HANDOFF.md` against durable GitHub authority. If stale, ignore stale
   phase/gate/next-action claims.
9. If stale `HANDOFF.md` cannot legally be updated because tracked mutation/main is
   frozen, publish/read-back a durable `STALE_POINTER_ONLY` (or equivalent) receipt bound
   to the stale file/blob and current authoritative landing pointers. Do **not** mutate a
   frozen product branch merely to repair handoff metadata. Update the tracked pointer at
   the next legal maintenance boundary.
10. Reconstruct the minimum current matrix:
   `component | role/surface | durable proof | capability class | target applicability |
   current liveness | restrictions`.
11. Recall already-durable owner decisions and do not ask the owner again unless newer
   durable evidence creates a real conflict.
12. Only after this gate choose BEST_NEXT, bounded repair, or durable NO_OP/BLOCKED.

A new Control candidate is not ACTIVE merely because it has the correct display name.
Activation must satisfy the current generation ACK / routing-canary / switch protocol.

## 4. Evidence reuse, blocker classification, and currentness

Never collapse these concepts:

- `CAPABILITY_PROVEN`: a bounded capability has durable success evidence.
- `CURRENT_LIVENESS`: the exact proven route is reachable now.
- `TARGET_APPLICABILITY`: the route is authorized/suitable for the current target.
- `PHYSICAL_DELIVERY`: an addressed executor actually received/consumed the event.
- `AUTHORITY_PUBLICATION`: a durable GitHub instruction/result exists.

Before opening any admission/discovery/canary, search still-valid durable success evidence
for the exact executor identity, surface, and task class as required by
`D22977/gpt-browser-bridge#81` receipt `5343071985`.

If capability is already `PROVEN_BOUNDED` and no newer durable invalidation exists:

1. Do not re-prove the capability merely because current runtime state is unknown.
2. Perform only the smallest current `ACCESS_CAPABILITY_CHECK_V1` or equivalent at the
   beginning of the real authorized task.
3. If current liveness fails, allow at most one bounded mechanical restore/restart of
   the **same proven route** when safe and authorized.
4. Do not infer capability absence from the wrong executor surface. A CLI/API lane
   reporting `iab unavailable` says nothing about a Desktop app-managed browser route.

Before dispatch, classify the missing edge at minimum as one of:

`EXECUTOR_CAPABILITY | CURRENT_RUNTIME_ACCESS | PHYSICAL_DELIVERY_OR_LIVENESS |
PRODUCT_IMPLEMENTATION | REVIEW_TRANSPORT | ARCHITECTURE_OR_SCOPE`.

A repair aimed at one class must not silently expand into re-testing another class.
Infrastructure curiosity must not displace the product critical path.

## 5. Exact executor-surface binding

Before dispatch or consume, bind all available identity fields:

- role
- agent name
- executor instance id
- surface (`DESKTOP`, `CLI`, service, connector, browser runtime, etc.)
- model binding when materially relevant
- repo + card/review scope
- current durable receipt/request identity

Never route only by model family. Never ask a CLI lane to prove a Desktop-only browser
surface. Never reuse another executor's browser profile/session to manufacture PASS.
Wrong-target, stale, malformed, conflicting, or ambiguous bindings fail closed.

## 6. Restart-safe GitHub pull/wake pattern

When a local Worker/agent must resume from GitHub, prefer the proven patterns from
`D22977/gpt-browser-bridge#62` and `D22977/gpt-browser-bridge#65` rather than inventing a
new orchestrator:

- GitHub is the durable task channel.
- Every wake/process start rereads current GitHub authority.
- Use native single-flight (`Do not start a new instance` / `IgnoreNew`) where the
  admitted Windows Task Scheduler pattern applies.
- Persist only enough deterministic state for restart reread; local state never outranks
  GitHub.
- Duplicate wake/tick/result consumption => `NO_OP_DUPLICATE`, never a second semantic
  action.
- Wrong repo/issue/receipt/protocol, stale READY/result, malformed or conflicting
  authority => fail closed / no mutation.
- No legal work => `NO_OP`, not invented busywork.
- Normal-path `user_relay_target = 0` after bootstrap.

Historical PASS proves bounded mechanism design; target binding/liveness is still checked
at execution time without re-admitting the mechanism itself.

## 7. Dispatch lifecycle — never collapse states

Report only the highest state supported by durable evidence:

`CARD_EXISTS -> DISPATCH_REQUEST_WRITTEN -> CONSUMED_STARTED -> TERMINAL_RESULT`

- `CARD_EXISTS` is not execution.
- GitHub dispatch/wake prose is not execution.
- `CONSUMED_STARTED` requires executor-authored durable evidence bound to executor and
  session/pane/runtime identity where applicable.
- `TERMINAL_RESULT` requires the exact terminal durable receipt.

If dispatch ages without a valid local consumer, stop creating more dependent product
cards and repair/admit the physical wake binding. Independent proven lanes may continue
when they do not depend on that failed consumer.

## 8. Automatic Control reporting and user-relay-zero

Preserve `D22977/gpt-browser-bridge#81` receipt `5315671361`:

`TERMINAL_DURABLE != AUTO_REPORT_COMPLETE`.

For a card that terminates at a Control-owned boundary, handoff is complete only when the
current durable contract requires and proves the applicable chain:

1. source terminal/READY/review result is durably published and read back;
2. exactly one bound Control-return request exists when required;
3. exactly one admitted deterministic Control doorbell/wake binds that return request to
   the current ACTIVE Control generation when such a transport is available;
4. delivery/ACK evidence is recorded when the admitted transport provides it;
5. duplicate delivery returns `NO_OP_DUPLICATE` and causes no second semantic action.

The user is not the normal task/result courier. If the admitted automatic route is not
live, publish the exact BLOCKED/HUMAN_REQUIRED transport evidence and the first missing
capability. Do not silently fall back to user relay as PASS.

## 9. Formal review, Browser transport, and reviewer-owned publication

Formal review is an independent role, not a Worker, Control, or browser-transport role.

### 9.1 Bounded ChatGPT-Web transport proof

`D22977/gpt-browser-bridge#83` receipts `5252595723` and `5252645117` prove a **bounded**
Codex Desktop app-managed isolated fresh ChatGPT-Web route for the admitted Desktop
transport lane. The proof establishes creation of a signed-in
`NEW_CONVERSATION_EMPTY` context and exactly-once minimal wake with zero user relay when
current runtime admission succeeds. It does **not** prove universal reachability across
all hosts/projects and does not grant reviewer/product authority to Desktop transport.

Therefore:

1. Do not repeatedly test whether ChatGPT Web can receive review prompts or Desktop can
   send them when this bounded proof is applicable and not durably invalidated.
2. Bind the exact admitted Desktop TRANSPORT/SENDER surface and perform only current
   liveness/applicability admission.
3. Control may authorize the review request but **must not operate the Browser DOM or
   physically send it**. The distinct TRANSPORT/SENDER sends exactly once.
4. Connector/CLI routes remain advisory unless current durable authority explicitly
   admits them as the formal reviewer lane for that review identity.

### 9.2 Exactly-once review-send identity

An exactly-once review wake must be bound by a deterministic identity tuple. At minimum,
when those fields exist, bind:

- repository + card/review issue
- `review_request_id`
- source READY/terminal receipt id
- exact candidate head/commit identity
- exact allowed file set or deterministic file-set digest
- prompt/envelope hash or equivalent immutable wake identity
- intended reviewer role/surface and fresh target context/session identity or nonce

Exact replay of the same tuple => `NO_OP_DUPLICATE` / `REUSED`.
Same identity key with conflicting payload/head/file-set => fail closed as conflict.
New candidate/head => old request is stale/superseded and must not be reused.

### 9.3 Reviewer-owned result publication

A fresh Reviewer must independently reread GitHub, review the exact current identity, and
publish/read back exactly one formal result when its lane has native durable write
capability. Historical proof exists in `D22977/gpt-browser-bridge#50` receipt
`5230984658`, where Grok independently read GitHub and self-published its own result.

If an external reviewer can read but cannot durably publish its own result, treat that as
an explicit publication limitation (`READ_PASS_WRITE_BLOCKED` or equivalent). Any owner
or Control proxy repost must preserve exact provenance and is secondary external-review
evidence, **not** reviewer-owned formal terminal authority, unless an exact current
contract explicitly delegates a deterministic publisher boundary with preserved
reviewer identity and idempotency.

No self-review, proxy masquerading, duplicate formal result, mutation during review, or
implicit merge/release authorization.

## 10. Review-result idempotency and repair loop

Preserve the proven idempotency direction from `D22977/gpt-browser-bridge#45` and
`D22977/gpt-browser-bridge#46`:

- formal result identity binds `review_request_id`, source READY receipt, exact candidate
  head, exact generation/round when relevant, reviewer session/identity, and current
  authority tuple;
- exact replay returns REUSED/NO_OP rather than another authoritative result;
- conflicting payload for the same binding fails closed;
- stale head/generation/READY mismatch is rejected before repair or successor action.

Worker stops at READY / WAIT_REVIEW / NO_MUTATION. A NEW fresh independent Reviewer owns
the verdict. PASS does not imply merge/release. FIX_REQUIRED authorizes only the exact
bounded repair permitted by current durable authority, followed by a new candidate
identity and NEW fresh review context. BLOCKED or scope expansion returns to Control.

## 11. Handoff contract and freeze-safe landing pointers

`HANDOFF.md` is a landing pointer, never a frozen authority snapshot. Latest durable
GitHub authority supersedes it.

At minimum a maintained handoff should point to:

- durable Control repo/issue and instruction to read latest comments first;
- active Control generation/switch receipt when generation semantics apply;
- current P0/BEST_NEXT;
- exact current candidate/product identity;
- card states using the four lifecycle states in §7;
- capability registry / architecture pointer;
- proven route references relevant to the critical path;
- local wake-consumer binding/liveness pointer when needed;
- current formal-review route when review is P0;
- already-satisfied owner decisions that must not be re-asked;
- explicit forbidden actions;
- freshness marker (`generated_at`, `supersedes`, or equivalent).

If tracked handoff mutation is currently forbidden, use the §3 durable
`STALE_POINTER_ONLY` fallback and leave frozen product main untouched.

## 12. Control generation rotation

Control-generation rotation must remain fail-closed and identity-bound. Preserve the
current standards on `D22977/gpt-browser-bridge#81` and
`D22977/gpt-browser-bridge#88`:

- generation display name is not authority;
- bind exact conversation/session identity and durable generation ACK;
- old Control remains ACTIVE until the new Control has GitHub-rehydrated,
  self-published/read-back its required generation ACK, and passed the routing canary;
- only then may a durable switch retire/supersede the old generation;
- stale delivery to retired generation => `NO_OP_RETIRED`;
- no user result relay as the normal switch path.

## 13. Duplicate/noise discipline and preauthorized loops

- Do not create another Router/Discovery/Admission card when existing durable proof plus
  bounded current liveness is sufficient.
- Do not repeat owner questions already resolved durably.
- Do not post repeated wake comments without new evidence or a defined retry rule.
- Do not create sidework merely to keep agents busy.
- `NO_OP` is correct when no legal useful action exists.
- Prefer one bounded action that removes the critical blocker over governance fan-out.
- A deterministic executor may consume a preauthorized PASS/FIX_REQUIRED/READY routing
  transition exactly as carded; this does not grant it authority to invent BEST_NEXT or
  expand scope.

## 14. Git and mutation prohibitions

Unless exact current authority permits otherwise, never use destructive or attribution-
destroying operations such as `git reset --hard`, `git clean`, `git stash`, force push,
deletion of unknown files, moving other projects' files, or whole-repo formatting.
Unknown dirty attribution fails closed.

Formal review, capability PASS, transport PASS, or skill branch presence does not by
itself authorize merge, release, workflow dispatch, final publication, successor
activation, CAD mutation, or local-adapter synchronization as accepted guidance.

## 15. Resume algorithm

After crash/restart/handoff:

1. Re-read and admit the canonical skill/local adapter per §3.
2. Run the GitHub rehydration gate.
3. Determine exact durable state and critical path.
4. Search strongest still-valid positive evidence as well as newest HOLD/BLOCKED
   evidence before choosing a repair.
5. Classify the missing edge per §4.
6. Select among proven capabilities by target applicability, current liveness, auth,
   reboot/restart behavior, cost, and human-free productive minutes.
7. Run only the minimal current liveness/binding check for the selected proven route.
8. Execute exactly the current legal action, or publish bounded BLOCKED/NO_OP.
9. Read back every durable write.
10. Never repeat prior semantic work merely because a process, browser tab, or terminal
    restarted.

Do not treat stale HANDOFF, local state, browser tabs, terminal sessions, or chat memory
as stronger than current GitHub receipts.

## 16. Project-specific minimal-wake rehydration regression

`D22977/gpt-browser-bridge#88` remains the GBB Control-generation regression reference,
but every GBB-derived project must also maintain either:

1. a project-specific minimal-wake rehydration regression; or
2. an explicitly inherited regression fixture that binds that project's durable Control
   issue, current product identity, capability registry, and handoff rules.

The test prompt must be intentionally minimal and must not leak the expected answer
beyond a repo/project landing pointer. A fresh Control with no chat memory must be able
to reconstruct, from GitHub alone:

- current durable authority and ACTIVE generation when applicable;
- whether `HANDOFF.md` is stale;
- exact current candidate/product identity and card lifecycle states;
- strongest still-valid proven capabilities and their bounded scope;
- distinction between capability proof, current liveness, target applicability, and
  physical delivery;
- already-satisfied owner decisions;
- current P0/BEST_NEXT;
- role boundaries, exactly-once publication, and user-relay-zero behavior;
- why redundant Router/Admission/capability-test work is or is not warranted.

For the CAD incident class, a passing derived-project regression must be capable of
independently discovering a stale landing pointer, an already-proven bounded Desktop
fresh-WebGPT route, the need for only current liveness/applicability checking, the
existing formal review gate, and the prohibition on re-asking already-durable owner
confirmation or creating a redundant transport-discovery card.

A failed regression means the Control candidate/handoff is not accepted; do not repair
project architecture merely to make the Control candidate pass.

## 17. Skill-change governance

Changes to this Control Tower contract must follow the same separation it requires from
projects:

1. produce a bounded candidate on a non-accepted repair/candidate branch;
2. bind exact base, head, changed paths, and file/blob identity;
3. perform inexpensive self-attack only as preflight evidence, never acceptance;
4. obtain a NEW fresh independent external review of actual bytes;
5. reviewer-owned PASS is required before the candidate may be treated as accepted
   canonical guidance, subject to normal integration authority;
6. FIX_REQUIRED creates a new candidate identity and requires another fresh reviewer;
7. branch/default-lineage presence, Control authorship, or local sync is never PASS.
