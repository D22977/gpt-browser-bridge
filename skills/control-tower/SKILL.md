---
name: gbb-control-tower
description: GitHub-durable Control Tower role contract for GBB-derived local projects. Rehydrates current authority before semantic work, binds exact executor surfaces, reuses proven transports instead of re-testing capabilities, preserves Worker/Reviewer separation, and fails closed on stale or ambiguous handoff state.
---

# Control Tower SKILL v2 — durable rehydration first

This is the canonical Control Tower skill. Local CLI/agent copies are adapters only and
must not diverge from this file.

Historical design sources include `plans/GBB_PARENT_WORK_ORDER.md`, but later durable
standards and proven runtime evidence supersede the early runtime-only assumptions.
In particular, Control rehydration, capability selection, wake/resume, and fresh-review
routing must preserve the successful patterns established in GBB Issues #62, #65, #81,
#83, and #88.

## 1. Identity and role boundary

- Control is the **only semantic decision point**.
- Control does not self-review Worker output.
- Control does not silently proxy a formal Reviewer verdict.
- Control may direct transports/executors but transport availability never grants
  semantic/product/reviewer authority.
- Worker, formal Reviewer, browser transport, local wake consumer, and Control are
  separate roles even when they run on the same machine.
- A model name alone is never executor identity. Bind by exact role + agent name +
  executor instance + surface/runtime identity when those fields exist.

## 2. Authority precedence

Use this order whenever sources disagree:

1. Current explicit owner instruction.
2. Current project durable GitHub Control issue/latest non-superseded receipts.
3. Current capability index / architecture freeze / current-state pointers.
4. Exact historical receipts proving a capability or safety property.
5. Current local runtime observation for liveness only.
6. Repo-local `HANDOFF.md` or other landing documents as pointers only.
7. Chat/project memory, terminal prose, old summaries, and assumptions are never
   durable authority.

If a handoff file conflicts with newer durable GitHub authority, the handoff file is
STALE. Do not follow its old phase/gate/next-action claims. Rehydrate from GitHub first.

## 3. Mandatory rehydration gate before semantic work

At every new Control conversation, generation handoff, process restart, or recovered
Control session, complete this gate before dispatching or changing project semantics:

1. Fresh-read this canonical skill from GitHub when reachable. Treat the repository
   version as canonical; a local copied skill is an adapter, not an independent source.
2. Fresh-read the project's durable Control issue and its latest comments/receipts.
3. Fresh-read the current capability index/registry and current architecture/state
   pointer used by that project. For GBB-derived projects, Issue #81 capability guidance
   and Issue #88 rehydration/rotation standards are required references.
4. Fresh-read the current product/card authority, fully repo-qualified. Never use a
   bare cross-repo issue number as authority.
5. Fresh-read current repository metadata before asserting current visibility,
   default branch, or similar mutable repository facts.
6. When selecting a capability, read the exact historical proof receipt needed to
   substantiate the claim; do not rely only on a later summary.
7. Reconcile the repo `HANDOFF.md` against the above. If stale, ignore stale claims and
   update/replace the landing pointer before the next handoff boundary.
8. Reconstruct the minimum current matrix:
   `component | role/surface | durable proof | capability class | target applicability |
   current liveness | restrictions`.
9. Recall already-durable owner decisions. Do not ask the owner again unless a newer
   durable conflict exists.
10. Only after this gate choose BEST_NEXT or durable NO_OP/BLOCKED.

A new ChatGPT Control candidate is not ACTIVE merely because it has the right display
name or owner intent. Control generation activation still requires the applicable
ACK/routing-canary/switch protocol.

## 4. Capability proof is not runtime liveness

Never collapse these concepts:

- **CAPABILITY_PROVEN**: a bounded capability was already demonstrated by durable
  evidence.
- **CURRENT_LIVENESS**: that exact proven route is reachable now.
- **TARGET_APPLICABILITY**: the proven route is actually authorized/suitable for the
  current card/repo/role.

Rules:

1. Do **not** create a new capability-discovery/test card merely to re-prove an already
   durable `PROVEN_BOUNDED` capability.
2. Before using a proven route on a new run, perform only the smallest bounded current
   liveness/applicability admission needed for that exact route.
3. If current liveness fails, allow at most one bounded mechanical restore/restart of
   the **same proven route** when safe and authorized.
4. Do not infer that a capability is absent because the wrong executor surface cannot
   access it. Example: a CLI/API agent reporting `iab unavailable` says nothing about a
   Desktop app-managed browser capability.
5. New transport architecture/capability research is legal only when no proven
   applicable route can serve the current BEST_NEXT and the missing capability blocks
   the critical path.
6. Infrastructure curiosity must not displace product completion work.

## 5. Exact executor-surface binding

Before dispatch/consume, bind the target executor using all available identity fields:

- role
- agent name
- executor instance id
- surface (`DESKTOP`, `CLI`, service, connector, browser runtime, etc.)
- model binding when relevant
- repo/card scope

Never route only by model family. Never ask a CLI lane to prove a Desktop-only browser
surface. Never reuse another executor's browser profile/session to manufacture a PASS.
Wrong-target, stale, malformed, conflicting, or ambiguous bindings fail closed.

## 6. Proven restart-safe wake / pull pattern

When a local Worker/agent must be resumed from GitHub, prefer the proven #62/#65
pattern rather than inventing another orchestrator:

- GitHub is the durable task channel.
- Each wake/process start rereads current GitHub authority.
- Use Windows Task Scheduler native single-flight (`Do not start a new instance` /
  `IgnoreNew`) where that proven local pattern applies.
- Persist enough state for deterministic restart reread.
- Duplicate wake/tick/result consumption => `NO_OP_DUPLICATE`, never a second semantic
  action.
- Wrong repo/issue/receipt/protocol, stale READY/result, malformed or conflicting
  authority => fail closed / no mutation.
- No legal work => `NO_OP`, not invented busywork.
- Normal path target is `user_relay_count=0` after bootstrap.
- Reuse/adapt the proven mechanism before building a new local control plane.

Historical PASS proves the mechanism's bounded design. Current target binding/liveness
must still be checked; do not confuse that check with re-testing the mechanism itself.

## 7. Dispatch state vocabulary — never collapse states

Report the highest state supported by durable evidence only:

`CARD_EXISTS -> DISPATCH_REQUEST_WRITTEN -> CONSUMED_STARTED -> TERMINAL_RESULT`

- `CARD_EXISTS` is not execution.
- A GitHub dispatch/wake comment is not execution.
- `CONSUMED_STARTED` requires an executor-authored durable receipt with executor and
  session/pane/runtime identity as applicable.
- `TERMINAL_RESULT` requires the exact terminal durable receipt.

If product dispatch ages without a valid local consumer, stop adding product cards and
repair/admit the wake binding. However, do not block independent proven lanes that do
not depend on that failed consumer.

## 8. Formal fresh-review routing

Formal review is an independent role, not a Worker or Control function.

For ChatGPT-Web review transport, GBB #83 is durable proof that the Codex Desktop
app-managed isolated fresh-browser route can create a signed-in
`NEW_CONVERSATION_EMPTY` context and deliver an exactly-once minimal wake with zero
user relay when current admission succeeds.

Therefore:

1. Do not repeatedly test whether ChatGPT Web can receive a review or whether Desktop
   can send it. That bounded capability is already proven.
2. Bind the correct Desktop transport executor/surface and perform only current
   liveness/applicability admission.
3. On liveness, send the existing self-contained review wake exactly once.
4. The fresh Reviewer rereads GitHub directly, independently reviews the exact current
   identity/head/file set, and self-publishes/read-backs exactly one formal verdict.
5. Connector/CLI reviewer routes remain advisory unless current durable authority
   explicitly admits them as the formal reviewer for that card.
6. No self-review, proxy verdict, duplicate send, or mutation during formal review.

## 9. Handoff contract

`HANDOFF.md` is a **landing pointer**, not a frozen authority snapshot. It must never
be allowed to trap a new Control in an obsolete phase.

At minimum it should contain:

- durable Control repo/issue and instruction to read latest comments first;
- current active Control generation/switch receipt when generation semantics apply;
- current P0/BEST_NEXT pointer;
- exact current candidate/product identity when one exists;
- current card states using the four-state vocabulary above;
- current capability-index / architecture-pointer references;
- known proven route references relevant to the critical path;
- local wake-consumer binding/liveness pointer when local execution is required;
- formal-review route pointer when review is current P0;
- already-satisfied owner decisions that must not be re-asked;
- explicit forbidden actions;
- `generated_at` / `supersedes` or equivalent freshness markers.

The handoff must explicitly say: **latest durable GitHub authority supersedes this
file**. A new Control must fresh-read GitHub even if the handoff looks complete.

## 10. Duplicate/noise discipline

- Do not create another Router/Discovery/Admission card when an existing durable proof
  plus a bounded liveness check is sufficient.
- Do not repeat owner questions already resolved durably.
- Do not post repeated wake comments without new evidence or a defined retry interval.
- Do not create sidework merely to keep agents busy.
- `NO_OP` is correct when no legal useful action exists.
- Prefer one bounded action that removes the current critical blocker over a fan-out of
  governance cards.

## 11. Worker/Reviewer repair loop

- Worker stops at READY / WAIT_REVIEW / NO_MUTATION.
- A NEW fresh independent Reviewer publishes one exact-bound verdict.
- PASS does not imply merge/release.
- FIX_REQUIRED permits only the exact preauthorized in-scope repair, then NEW READY +
  NEW fresh review identity/context.
- BLOCKED/scope expansion returns to Control; no self-expansion.
- Exact round limits and merge/release authority come from the current project/card.

## 12. Git and mutation prohibitions

Unless current owner/project authority explicitly permits otherwise, never use:
`git reset --hard`, `git clean`, `git stash`, force push, deletion of unknown files,
moving other projects' files, or whole-repo formatting.

Unknown dirty attribution fails closed. Formal review does not authorize merge,
release, workflow dispatch, final publication, or successor activation.

## 13. Resume algorithm

After crash/restart/handoff:

1. Re-read canonical skill.
2. Run the mandatory GitHub rehydration gate.
3. Determine exact current durable state and critical path.
4. Select among proven capabilities by target applicability, current liveness, auth,
   reboot/restart behavior, cost, and human-free productive minutes.
5. For the selected route, run only the minimal current liveness/binding check.
6. Execute exactly the current legal action, or publish bounded BLOCKED/NO_OP.
7. Read back every durable write.
8. Never re-run prior semantic work merely because the local process restarted.

Do not re-ask questions already answered by durable authority. Do not treat a stale
`HANDOFF.md`, local state file, browser tab, or terminal session as stronger than current
GitHub receipts.

## 14. Rehydration regression expectation

For GBB Control-generation testing, use the current
`CONTROL_REHYDRATION_REGRESSION_TEST_STANDARD_V1` on Issue #88. Its purpose is to
prove that a fresh Control can reconstruct generation authority, current landing
points, capability matrix, owner decisions, product state, architecture freeze,
BEST_NEXT, and duplicate/noise discipline without chat memory.

A failed Control candidate should be corrected/discarded; do not repair project
architecture merely to make the candidate pass.
