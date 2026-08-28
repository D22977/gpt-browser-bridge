---
name: gbb-control-tower-v4-candidate
description: Candidate amendment to the admitted gbb-control-tower contract. Adds handoff-first navigation, success-first evidence reuse, and default quarantine of superseded failures while preserving fail-closed authority reconciliation.
---

# Control Tower SKILL v4 candidate — handoff-first, success-first

**Candidate only. Not canonical until fresh independent review and exact integration authority.**

This candidate inherits every non-conflicting rule from the admitted `skills/control-tower/SKILL.md` at base head `50cd14c941072de5ea04690f286683c05eac1d81`, blob `babbb3f704b852f499d96d2cb1ac7493e71cc851`.

Its purpose is narrow: make good handoff behavior deterministic and prevent superseded failure history from repeatedly dragging Control back into already-solved capability work.

## 1. Handoff-first navigation, authority unchanged

At every new Control conversation, generation handoff, process restart, recovered session, or local adapter transition:

1. Read `skills/control-tower/HANDOFF.md` **first** as a navigation landing document.
2. Do not treat that first read as authority. Immediately bind the admitted canonical `SKILL.md` exact ref/head/blob and current project durable Control authority.
3. If any handoff pointer conflicts with current owner instruction or current durable GitHub authority, mark that pointer stale and continue from the authoritative source.

This changes **reading order**, not authority precedence.

Project-local `HANDOFF.md` files remain pointers only. They may be read early to locate current state, but their phase/gate/next-action claims must be reconciled before semantic use.

## 2. Success-first evidence selection

Before reading historical failures or opening any capability/admission/discovery work:

1. Read `SUCCESS_EVIDENCE_INDEX.md`.
2. Select the narrowest still-valid success/proven receipt matching exact executor + surface + task class.
3. Read the exact durable success receipt needed for the active claim.
4. Check for a newer durable invalidation.
5. If none exists, reuse the proof. Unknown current liveness does not erase bounded capability proof.
6. At actual execution, perform only the smallest current liveness/target binding required by the task.

A newer exact PASS/correction supersedes an older failure for normal capability selection unless the success receipt explicitly limits or revokes that scope.

## 3. Failure archive quarantine

`FAILURE_ARCHIVE.md` is **excluded from normal rehydration and capability selection**.

Control may open only the exact relevant archived entry when:

- the same current error signature appears on the same executor/surface;
- an independent reviewer requests historical lineage;
- a current success/correction receipt explicitly points back to that failure;
- the owner explicitly requests historical failure inspection.

Archived failures are audit/diagnostic evidence. They are not current blockers when a newer exact success/correction supersedes them.

Control must not:

- re-run a capability test merely because an archived failure exists;
- create a new Router/admission/discovery path to answer a superseded failure;
- infer Desktop capability absence from a CLI/API failure;
- ask the owner again for a decision already durably satisfied;
- replay the entire failure archive during every handoff.

## 4. Archive entry contract

Every archived failure must carry enough structure to prevent accidental resurrection:

- archive ID;
- repo-qualified receipt/file identity;
- executor and surface;
- exact error signature or stale claim;
- classification;
- `superseded_by` exact receipt(s), when applicable;
- current selection rule.

Pending/nonterminal work is not automatically a failure. It remains pending until an exact terminal state exists.

## 5. Local adapter handoff

A local skill adapter is optional. If it is used, its bytes must be verified against the current admitted canonical Skill.

- exact match => admitted for that exact canonical identity;
- mismatch/unverified => `LOCAL_SKILL_STALE` / not admitted;
- canonical GitHub bytes directly available => Web Control may use canonical bytes without allowing an unverified local adapter to override them;
- do not duplicate-dispatch an existing exact local-sync card merely because synchronization is pending.

## 6. Minimum fresh-Control landing artifact

A correct handoff should let the successor reconstruct the following without replaying archived failures:

- active Control generation and switch receipt;
- canonical Skill exact identity;
- current project Control landing pointer;
- current product/main/candidate exact identity;
- strongest still-valid success/proven evidence relevant to BEST_NEXT;
- only task-required current liveness;
- unresolved pending items;
- explicit forbidden actions.

If those facts cannot be reconstructed from the handoff + canonical Skill + success index + current durable project authority, fail closed and repair the landing pointers rather than reopening unrelated old failures.

## 7. Review acceptance tests for this candidate

A fresh independent reviewer should verify at minimum:

1. Reading `HANDOFF.md` first cannot override authority precedence.
2. A stale project handoff still fails closed and is not trusted as product authority.
3. GBB #83 Desktop WebGPT PASS is selected before old CDP/CLI failures for a matching Desktop review transport task.
4. CAD #13 CLI/IAB failure cannot invalidate GBB #83 Desktop proof.
5. Failure archive is not required during normal rehydration.
6. An actually recurring same-surface error can still reach the exact archived diagnostic entry.
7. Pending #97 local adapter sync is not mislabeled as terminal failure.
8. Local adapter mismatch cannot override canonical GitHub bytes.
9. No success entry grants authority beyond its original bounded scope.
10. No rule permits self-review, proxy reviewer verdict, merge/release inference, or product mutation merely because a capability is proven.
