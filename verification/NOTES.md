# DreamDesk — Lean 4 verification notes

Model: `Desk.lean` (this directory). Self-contained Lean 4.34.1, core
library only, no Mathlib.

Build / self-check:

```
~/.elan/bin/lean Desk.lean        # exit 0; deprecation warnings for
                                  # String.trim only (kept deliberately:
                                  # the code calls .trim())
grep -n "sorry\|admit" Desk.lean  # no hits
```

`#print axioms` on the headline theorems shows only the standard Lean
axioms (`propext`, `Classical.choice`, `Quot.sound`) — no custom axioms,
no `sorryAx`. No source files were modified; `verification/` is the only
addition.

## Modeling choices

- Hashing (SHA-256 in `ledger.ts:28`, `chp-ledger.ts`) is abstracted as an
  arbitrary function `H` / `D`. All chain/integrity theorems hold for
  every `H`, so they do not rely on collision resistance — they prove the
  *linkage logic* is exactly what `verifyChain` checks.
- Money, probabilities and confidence are modelled with `Int`
  comparisons (e.g. confidence 60 ≡ 0.60). IEEE-754 behaviour (NaN,
  infinities) is therefore out of scope for the theorems; where NaN
  matters in the code it is flagged below as a note, not a theorem.
- The audit event's hashed content is abstracted to one record `Ev`;
  `GENESIS` is the exact code value (`ledger.ts:17`).
- Concurrency is out of scope: theorems model the sequential behaviour.
  See risk R6 — the real `audit()` is not serialised.

## Theorem → source mapping

### §1 CHP session lock — `src/lib/desk/chp.ts`, class `SessionLock` (279-330)

Model: `LockState`, `Lock`, `Lock.fresh`, `openProvisional` (chp.ts:285-295),
`confirm` (chp.ts:297-322), `applyOp`, `Reach`.

| Theorem | Property | Source |
|---|---|---|
| `applyOp_rank_mono` | Lock state never regresses (EXPLORING < PROVISIONAL_LOCK < LOCKED) | chp.ts:285-322 |
| `applyOp_of_locked` | LOCKED is absorbing: both operations rejected, lock bit-for-bit unchanged | chp.ts:290, 306 |
| `confirm_rejected` | `confirm` from EXPLORING/LOCKED or with a blank name is a no-op rejection — no EXPLORING → LOCKED skip at the step level | chp.ts:303-309 |
| `confirm_success` | Successful confirm lands exactly in LOCKED with the trimmed name + validation record | chp.ts:311-322 |
| `step_into_locked` | Entering LOCKED requires predecessor PROVISIONAL_LOCK + non-blank `confirm` | chp.ts:297-322 |
| `LockInv.init`, `LockInv.step`, `reach_inv` | Invariant preserved over all reachable states | — |
| `reach_locked_confirmer` | Any reachable LOCKED lock carries a recorded non-blank confirmer + validation | engine.ts:714-736 (view) |
| `reach_locked_needs_provisional` | Trace-level no-skipping: every reachable LOCKED was produced by a `confirm` out of a reachable PROVISIONAL_LOCK | chp.ts:279-330 |

### §2 Audit hash chain — `src/lib/desk/ledger.ts`, `engine.ts` `audit()`

Model: `Ev`, `Row`, `GENESIS` (ledger.ts:17), `Linked`, `verifyFrom`
(ledger.ts:49-86), `tipHash`, `appendRow` (engine.ts:738-746).

| Theorem | Property | Source |
|---|---|---|
| `verifyFrom_of_linked` | Every linked chain passes `verifyChain` (completeness) | ledger.ts:49-86 |
| `verifyFrom_iff` | `verifyChain` accepts **exactly** the linked chains (soundness + completeness): any tampered payload/hash/link anywhere fails verification | ledger.ts:19-29, 49-86 |
| `tipHash_cons`, `linked_appendRow` | Append-only correctness: an `audit()`-style append (link to current tip, hash over it) preserves linkage; history is extended, never rewritten | engine.ts:743-745 |
| `verifyFrom_appendRow` | A chain built solely from `audit()` appends always verifies | engine.ts:738-746 |

### §3 Limits of chain verification

| Theorem | Property | Source |
|---|---|---|
| `verifyFrom_init` | Verification of a concatenation implies verification of its head | ledger.ts:49-86 |
| `verifyFrom_prefix_of_linked` | **Counterexample:** any proper prefix of a valid chain verifies — tail truncation is undetectable without an externally anchored tip/count | ledger.ts:49-86 |

### §4 R0 gate — `chp.ts` `evaluateR0Gate` (54-118), called at chp.ts:403

| Theorem | Property | Source |
|---|---|---|
| `r0Pass_iff` | R0 PASS ⟺ solvable (equity, notional > 0) ∧ valid (side, 0 < p < 1) ∧ worthIt (signed edge > 0) | chp.ts:86-117 |
| `r0_no_edge_no_pass` | Non-positive edge vetoes; engine passes edge = −1 when the venue price is unknown | engine.ts (decision cycle), chp.ts:103 |

`scoped` is omitted from the model: it is computed from fixed desk
constants (chp.ts:389-394, config.ts) and is true on every call the
engine can make. Flagged as R7.

### §5 Profile B gate — `@cubiczan/chp` 0.1.1 `dist/gate.js` (`evaluateGate`), policy from `chpPolicy()` (chp.ts:339-368)

| Theorem | Property | Source |
|---|---|---|
| `evalB_cases` | Every evaluation is exactly one of BLOCKED (hard failure, delta 0) / HITL_REQUIRED (hard checks pass, notional ≥ threshold) / LOCKED (hard checks pass, notional < threshold, delta = notional) | gate.js `evaluateGate` |
| `evalB_locked_imp` | LOCKED ⟹ all hard checks passed ∧ notional strictly below the HITL threshold ∧ committed delta = notional | gate.js; chp.ts:412-423 |
| `evalB_hitl_of_threshold` | The HITL threshold is **inclusive**: notional = threshold (default 250) already requires a human, and the desk refuses HITL (no self-approval) | gate.js; chp.ts:416-423 |
| `evalB_blocked_delta` | Blocked trades commit 0 — refusals never consume the daily cap | gate.js |

### §6 Foundation gate — `chp.ts` `assessTradeFoundation` (144-278)

| Theorem | Property | Source |
|---|---|---|
| `foundEval_pass_imp` | PASS ⟹ all three legs: risk gates green (+40), bounded order (+30), consistent venue book (+30); any missing leg caps the score at 70 < 85 (defi floor) | chp.ts:348-385 |
| `foundEval_no_book` | **Counterexample:** with no complete venue quote (missing bid or ask), parity is `state_assertions`, scores 0, max score 70 < 85 → foundation always REFRAME → composite gate refuses | chp.ts:360-372, 438-448 |

### §7 Composite gate + actuation — `chp.ts` `runChpTradeGate` (389-470), `engine.ts` decision cycle

| Theorem | Property | Source |
|---|---|---|
| `compositeAllowed_imp` | `allowed` ⟹ R0 criteria ∧ all risk gates (risk.ts:22) ∧ Profile B LOCKED with hard checks + under HITL threshold ∧ foundation PASS with all legs ∧ human-lock condition (required + LIVE ⟹ lock LOCKED; PAPER exempt) | chp.ts:389-470 (lock check at 457) |
| `engineAct_imp` | The engine actuates (execution adapter + CHP ledger seal, engine.ts:459, 646) only on the allowed path, and the sealed amount equals the trade notional | engine.ts:452-473, 646+ |

### §8 Engine lifecycle — `engine.ts`

Model: `SessState`, `Engine`, `engStart` (engine.ts:148), `engStop`
(engine.ts:202), `engChpOpen` (engine.ts:714-725).

| Theorem | Property | Source |
|---|---|---|
| `engStart_running` | `start()` rejected while RUNNING — no double sessions | engine.ts:148-152 |
| `engStop_idle` | `stop()` rejected while IDLE | engine.ts:202-206 |
| `engStart_fresh_lock` | Every successful start installs a **fresh** SessionLock — lock state never carries across sessions | engine.ts:148-180 |
| `engStop_terminal` | After stop: IDLE, no session, further stops rejected — STOPPED is terminal for that session | engine.ts:202-229 |
| `lock_mutates_while_idle` | **Counterexample:** the lock can be driven EXPLORING → PROVISIONAL_LOCK (and, per §1, to LOCKED with any non-blank name) with the engine IDLE and **no session at all** — the CHP endpoints check neither engine state nor session | engine.ts:714-736; src/app/api/desk/chp/route.ts:34-62 |
| `quiet_cycle_keeps_expired` | **Counterexample:** the quiet-cycle path (activity < 0.32, engine.ts:257-259) returns before settlement, so already-expired trades stay open until a later non-quiet cycle | engine.ts:231-300 |

### §9 CHP trade ledger — `src/lib/desk/chp-ledger.ts`

Model: `ChpRec`, `integrityOk` (chp-ledger.ts:52-58), `committedToday`
(chp-ledger.ts:102-113). The ledger is JSONL and records are **not**
hash-chained to each other (contrast §2).

| Theorem | Property | Source |
|---|---|---|
| `integrityOk_iff` | `integrity_valid` ⟺ stored digest = recomputed SHA-256 of body | chp-ledger.ts:52-58 |
| `committedToday_append` | Append-only accumulation: tail appends add exactly their own contributions; history is never rewritten. `append()` itself (chp-ledger.ts:65-67) performs **no** gate check — gating exists only in the engine path of §7 | chp-ledger.ts:65-67 |
| `committed_counts_envelope_invalid` | **Counterexample:** a record with `envelope_valid = false` still counts toward the daily committed total — `committedToday` consults integrity only | chp-ledger.ts:102-113 |
| `committed_ignores_bad_digest` | A digest-mismatched record contributes 0; conversely **any** correctly-digested body counts, whatever it claims — the sum trusts the sealed `execution.notional` and filters on nothing else (no session, mode, success or fill filter) | chp-ledger.ts:102-113 |

## Headline findings / discrepancies / risks

- **F1 — `chainOk` is always true in snapshots.** `engine.chainOk` is
  initialised `true` (engine.ts:132), surfaced in the snapshot
  (engine.ts:782), and never assigned anywhere else. Real verification
  happens only when the audit API route is called
  (src/app/api/desk/audit/route.ts:16). The UI's chain-health signal is
  decorative. (§2 theorems describe `verifyChain` itself, which is
  sound — the finding is that its result is not wired into the engine.)
- **F2 — Human lock has no authentication.** The CHP route
  (src/app/api/desk/chp/route.ts) has no auth or approver allowlist;
  `confirm` accepts any non-blank string as the named human
  (chp.ts:297-322), and per `lock_mutates_while_idle` the lock mutates
  even with no running session. The §1 theorems prove the *state
  machine* is strict; the *identity* behind a confirmation is
  unenforced. This is the desk's largest trust gap.
- **F3 — No-book foundation impossibility.** Per `foundEval_no_book`,
  the composite gate can never allow a trade when the venue book is
  missing or one-sided. Whether intended or not, live venue data is a
  hard dependency of every trade.
- **F4 — Tail truncation of the audit chain is undetectable**
  (`verifyFrom_prefix_of_linked`). `verifyChain` also never checks
  `seq` continuity or ordering — it verifies the rows it is handed, in
  the order handed (the route orders by `seq` asc; the function itself
  does not).
- **F5 — `EXEC_FAILED` vs `HELD` divergence.** On adapter failure the DB
  decision is set to `EXEC_FAILED` (engine.ts:452), but the in-memory
  `DecisionView.status` recomputation (engine.ts:473) has no
  `EXEC_FAILED` case and reports `HELD`. Operators see a held decision
  where the database recorded an execution failure. Also note
  `recordChpDecision` seals failed/non-filled outcomes too
  (engine.ts:459); they carry adapter-reported notional 0, so they do
  not consume the daily cap — consistent with §5's blocked-delta rule,
  but the ledger does contain non-trades by design.
- **F6 — Quiet cycles skip settlement** (`quiet_cycle_keeps_expired`),
  and `stop()` (engine.ts:202-229) does not settle or close open trades
  either. Expired/open positions can outlive both quiet cycles and the
  session itself.
- **F7 — `committedToday` trusts sealed bodies.** See §9
  counterexamples: no envelope-validity, session, mode, or fill-status
  filtering. Whoever can append a correctly-digested record can inflate
  (or, with negative notionals — nothing in `committedToday` rejects
  them — deflate) the daily committed total that Profile B enforces
  against. `append()` performs no validation of its own.
- **R6 — Audit concurrency (unmodelled).** `audit()` reads `this.prevHash`,
  awaits the DB write, and only then updates it (engine.ts:743-745),
  with no serialisation. CHP lock endpoints audit too, so concurrent
  audit calls can interleave and fork the in-memory chain head. The §2
  theorems cover the sequential behaviour only.
- **R7 — R0 `scoped` is vacuous as shipped.** It is derived from fixed
  constants and the live-session descriptor; if those constants change,
  the omitted conjunct starts to matter. The desk also calls
  `runChpTradeGate` only after the risk gates pass, so the gate's own
  risk re-check (modelled in §7) is redundant on the engine path.
- **R8 — Float edge cases (unmodelled).** The model uses integer
  comparisons. In the code, Profile B rejects non-finite notionals via
  its hard checks (a JS-only path the model folds into the `≤`
  comparisons); council/risk arithmetic elsewhere (edge = −1 sentinel,
  engine.ts decision cycle) is not similarly guarded in every path.
- **Divergence from README:** where the README describes the lock/gates
  aspirationally, the code was followed throughout — in particular the
  lock's reset is *per session construction* (there is no unlock/reset
  method on `SessionLock`), and the foundation stage's book dependency
  (F3) is a code fact, not a documented one.
