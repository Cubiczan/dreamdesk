/-
  DreamDesk — formal model of the desk engine, the CHP session lock,
  the composite trade gate, and the two ledgers.

  Sources modelled (all under src/lib/desk/ unless noted):
    * `SessionLock` state machine            — chp.ts:279-330
    * Composite trade gate `runChpTradeGate` — chp.ts:389-470
    * R0 gate `evaluateR0Gate`               — chp.ts:54-118
    * Foundation `assessTradeFoundation`     — chp.ts:144-278 (domain hardcoded "defi")
    * Profile B capital gate `evaluateGate`  — @cubiczan/chp 0.1.1 dist/gate.js
    * Engine decision-cycle branching        — engine.ts:231+ (`tickCycle`)
    * Audit hash chain                       — ledger.ts + engine.ts:738-746 (`audit`)
    * CHP trade ledger `committedToday`      — chp-ledger.ts:102-113

  Modelling choices: money/probability *quantities* are `Int` (the code uses
  IEEE-754 floats; every comparison modelled here is a straight-line threshold
  comparison, and float-only phenomena are flagged in NOTES.md instead).
  SHA-256 is an abstract function `H`. Sub-checks whose content is arithmetic
  on floats (venue mid, model anchoring) are abstracted to Booleans in the
  code's own terms.
-/

namespace DreamDesk

/- ============================ §1 Session lock ============================ -/

/-- Session lock states (chp.ts:247). -/
inductive LockState where
  | exploring
  | provisionalLock
  | locked
deriving DecidableEq, Repr

/-- The `SessionLock` object (chp.ts:281-323): current state, the recorded
    confirmer (`confirmedBy`, chp.ts:283), and whether a third-party
    validation record exists (`validation`, chp.ts:284 — observable through
    `lastValidation()`, chp.ts:320-322). -/
structure Lock where
  state : LockState
  confirmedBy : Option String
  validated : Bool
deriving DecidableEq

/-- A fresh lock: every engine session constructs `new SessionLock()`
    (engine.ts:139, 174) which starts EXPLORING with no confirmer. -/
def Lock.fresh : Lock := ⟨.exploring, none, false⟩

/-- `openProvisional` (chp.ts:290-299): LOCKED rejects; PROVISIONAL_LOCK is
    an ok self-loop; EXPLORING advances. -/
def openProvisional (l : Lock) : Lock × Bool :=
  match l.state with
  | .locked => (l, false)
  | .provisionalLock => (l, true)
  | .exploring => ({ l with state := .provisionalLock }, true)

/-- `confirm` (chp.ts:302-323): only from PROVISIONAL_LOCK, only with a
    name whose trim is non-empty; stores the *trimmed* name and the
    validation record, and moves to LOCKED. -/
def confirm (l : Lock) (name : String) : Lock × Bool :=
  match l.state with
  | .exploring => (l, false)
  | .locked => (l, false)
  | .provisionalLock =>
      if name.trim = "" then (l, false)
      else (⟨.locked, some name.trim, true⟩, true)

/-- The two operations the desk API can perform on the lock
    (engine.ts:718-739, src/app/api/desk/chp/route.ts:42-58). There is no
    reset/unlock operation anywhere in the code. -/
inductive LockOp where
  | open
  | confirm (name : String)

def applyOp (l : Lock) (op : LockOp) : Lock :=
  match op with
  | .open => (openProvisional l).1
  | .confirm n => (confirm l n).1

/-- Reachability: states a lock can be in after any sequence of API
    operations, starting from a fresh session lock. -/
inductive Reach : Lock → Prop where
  | init : Reach Lock.fresh
  | step {l : Lock} (h : Reach l) (op : LockOp) : Reach (applyOp l op)

/-- Position in the lifecycle; used for monotonicity. -/
def rank : LockState → Nat
  | .exploring => 0
  | .provisionalLock => 1
  | .locked => 2

theorem applyOp_rank_mono (l : Lock) (op : LockOp) :
    rank l.state ≤ rank (applyOp l op).state := by
  obtain ⟨st, cb, v⟩ := l
  cases st <;> cases op <;> simp only [applyOp, openProvisional, confirm, rank]
  · omega
  · omega
  · omega
  · rename_i n
    by_cases hb : n.trim = ""
    · rw [if_pos hb]
      exact Nat.le_refl 1
    · rw [if_neg hb]
      exact Nat.le_succ 1
  · omega
  · omega

/-- LOCKED is absorbing: once locked, both API operations are rejected and
    the lock (state, confirmer, validation) is completely unchanged. -/
theorem applyOp_of_locked {l : Lock} (h : l.state = .locked) (op : LockOp) :
    applyOp l op = l := by
  obtain ⟨st, cb, v⟩ := l
  dsimp only at h
  subst h
  cases op <;> rfl

/-- A rejected operation never changes the lock. In particular `confirm`
    from EXPLORING or LOCKED, or with a blank name, is a no-op — the
    "no state skipping" property at the single-step level for the
    EXPLORING → LOCKED jump (chp.ts:303-309). -/
theorem confirm_rejected {l : Lock} {n : String}
    (h : l.state = .exploring ∨ l.state = .locked ∨ n.trim = "") :
    (confirm l n).1 = l ∧ (confirm l n).2 = false := by
  obtain ⟨st, cb, v⟩ := l
  dsimp only at h
  cases st
  · simp [confirm]
  · have hn : n.trim = "" := by
      rcases h with h | h | h
      · cases h
      · cases h
      · exact h
    simp [confirm, hn]
  · simp [confirm]

/-- Computation rule for a successful `confirm` (chp.ts:311-322): from
    PROVISIONAL_LOCK with a non-blank name, the result is exactly the
    LOCKED lock carrying the trimmed name and the validation record. -/
theorem confirm_success {l : Lock} {n : String}
    (hs : l.state = .provisionalLock) (hn : n.trim ≠ "") :
    confirm l n = (⟨.locked, some n.trim, true⟩, true) := by
  obtain ⟨st, cb, v⟩ := l
  dsimp only at hs
  subst hs
  simp [confirm, hn]

/-- Single-step characterisation of entering LOCKED: the predecessor must
    be PROVISIONAL_LOCK and the operation a `confirm` with a non-blank
    name. This is the formal content of "no EXPLORING → LOCKED skip"
    (chp.ts:302-309). -/
theorem step_into_locked {l : Lock} {op : LockOp}
    (hprev : l.state ≠ .locked) (h : (applyOp l op).state = .locked) :
    l.state = .provisionalLock ∧ ∃ n, op = .confirm n ∧ n.trim ≠ "" := by
  obtain ⟨st, cb, v⟩ := l
  cases st <;> cases op <;> simp only [applyOp, openProvisional, confirm] at h
  · cases h
  · cases h
  · cases h
  · split at h
    · dsimp only at h
      cases h
    · exact ⟨rfl, _, rfl, by assumption⟩
  · exact (hprev rfl).elim
  · exact (hprev rfl).elim

/-- The lock invariant over reachable states: a LOCKED lock always carries
    a recorded, non-blank named confirmer and its validation record. (The
    converse directions — confirmer/validation exist *only* in LOCKED —
    hold by the same case analysis: only `confirm`'s success branch sets
    them, atomically with the move to LOCKED.) -/
def LockInv (l : Lock) : Prop :=
  l.state = .locked → ∃ n, l.confirmedBy = some n ∧ n ≠ "" ∧ l.validated = true

theorem LockInv.init : LockInv Lock.fresh := by
  intro h
  simp [Lock.fresh] at h

theorem LockInv.step {l : Lock} (hl : LockInv l) (op : LockOp) :
    LockInv (applyOp l op) := by
  by_cases hprev : l.state = .locked
  · rw [applyOp_of_locked hprev op]
    exact hl
  · intro hst
    obtain ⟨hs, n, hop, hn⟩ := step_into_locked hprev hst (op := op)
    subst hop
    have hsucc : applyOp l (.confirm n) = ⟨.locked, some n.trim, true⟩ := by
      have h2 : applyOp l (.confirm n) = (confirm l n).1 := rfl
      rw [h2, confirm_success hs hn]
    rw [hsucc]
    exact ⟨n.trim, rfl, hn, rfl⟩

theorem reach_inv {l : Lock} (h : Reach l) : LockInv l := by
  induction h with
  | init => exact LockInv.init
  | step hr op ih => exact ih.step op

/-- Corollary: any reachable LOCKED session has a recorded, non-blank
    named confirmer — the engine can never report a lock without one
    (engine.ts:714-736, the chp view). -/
theorem reach_locked_confirmer {l : Lock} (h : Reach l) (hl : l.state = .locked) :
    ∃ n, l.confirmedBy = some n ∧ n ≠ "" ∧ l.validated = true :=
  reach_inv h hl

/-- Trace-level no-skipping: every reachable LOCKED lock was produced by a
    `confirm` out of a reachable PROVISIONAL_LOCK lock. Any path from a
    fresh session to LOCKED passes through PROVISIONAL_LOCK and through a
    confirm step — there is no other route (the class has no other
    mutating methods). -/
theorem reach_locked_needs_provisional (l : Lock) (h : Reach l)
    (hl : l.state = .locked) :
    ∃ l' n, Reach l' ∧ l'.state = .provisionalLock ∧ n.trim ≠ "" ∧
      applyOp l' (.confirm n) = l := by
  induction h with
  | init => simp [Lock.fresh] at hl
  | step hr op ih =>
      rename_i lp
      by_cases hc : lp.state = .locked
      · obtain ⟨l', n, hr', hs', hn, hstep⟩ := ih hc
        exact ⟨l', n, hr', hs', hn, hstep.trans (applyOp_of_locked hc op).symm⟩
      · obtain ⟨hs, n, hop, hn⟩ := step_into_locked hc hl (op := op)
        exact ⟨lp, n, hr, hs, hn, by rw [hop]⟩

/- ============================ §2 Audit hash chain (ledger.ts) ============================ -/

/-- One audit event's hashed content: engine.ts:738-746 passes
    `{seq, kind, actor, payload, prevHash, ts}` to `computeAuditHash`
    (ledger.ts:20-29), which hashes the `|`-join of the fields. -/
structure Ev where
  seq : Nat
  kind : String
  actor : String
  payload : String
  ts : String
deriving DecidableEq

/-- A stored audit row (ledger.ts:32-40): the event plus its chain links. -/
structure Row where
  ev : Ev
  prevHash : String
  hash : String
deriving DecidableEq

/-- The genesis anchor (ledger.ts:17: `"0x"` followed by 64 zero
    characters). No proof depends on the concrete value; what matters is
    that appends and verification share it. -/
def GENESIS : String := "0x0000000000000000000000000000000000000000000000000000000000000000"

/-- The linkage invariant `verifyChain` checks (ledger.ts:57-86): each
    row's `prevHash` is the running hash and each row's `hash` is the
    recomputation over its predecessor. `H` abstracts SHA-256
    (ledger.ts:28). -/
inductive Linked (H : String → Ev → String) : String → List Row → Prop where
  | nil {p : String} : Linked H p []
  | cons {p : String} {r : Row} {rs : List Row} :
      r.prevHash = p → r.hash = H p r.ev → Linked H r.hash rs →
      Linked H p (r :: rs)

/-- `verifyChain` folded into a boolean recursion (ledger.ts:57-86): walk
    from a starting hash, checking link and recomputation at each row.
    The route src/app/api/desk/audit/route.ts:12-16 feeds it the current
    session's rows ordered by `seq` ascending, starting from GENESIS. -/
def verifyFrom (H : String → Ev → String) (p : String) : List Row → Bool
  | [] => true
  | r :: rs => decide (r.prevHash = p) && decide (r.hash = H p r.ev) &&
      verifyFrom H r.hash rs

/-- Completeness direction, by induction on the linkage derivation: every
    linked chain passes `verifyChain`. -/
theorem verifyFrom_of_linked {H : String → Ev → String} {p : String}
    {rows : List Row} (h : Linked H p rows) : verifyFrom H p rows = true := by
  induction h with
  | nil => rfl
  | cons hp hh hrest ih =>
      simp only [verifyFrom, Bool.and_eq_true, decide_eq_true_eq]
      exact ⟨⟨hp, hh⟩, ih⟩

/-- Soundness AND completeness of `verifyChain`: it accepts exactly the
    linked chains. Any tampering with a stored payload, hash, or link —
    anywhere in the chain — makes verification fail, and every untampered
    chain verifies. -/
theorem verifyFrom_iff {H : String → Ev → String} {p : String} :
    ∀ rows : List Row, verifyFrom H p rows = true ↔ Linked H p rows := by
  intro rows
  induction rows generalizing p with
  | nil =>
      constructor
      · intro _; exact Linked.nil
      · intro _; rfl
  | cons r rs ih =>
      constructor
      · intro hv
        simp only [verifyFrom, Bool.and_eq_true, decide_eq_true_eq] at hv
        obtain ⟨⟨h1, h2⟩, h3⟩ := hv
        exact Linked.cons h1 h2 (ih.mp h3)
      · intro h
        exact verifyFrom_of_linked h

/-- The hash the next appended row must link to: the fold the engine
    performs implicitly by carrying `prevHash` (engine.ts:133, 756). -/
def tipHash (p : String) (rows : List Row) : String :=
  rows.foldl (fun _ r => r.hash) p

/-- One engine `audit()` append (engine.ts:738-746): the new row links to
    the current tip and is hashed over it. -/
def appendRow (H : String → Ev → String) (p : String) (rows : List Row)
    (e : Ev) : List Row :=
  rows ++ [⟨e, tipHash p rows, H (tipHash p rows) e⟩]

theorem tipHash_cons (p : String) (r : Row) (rs : List Row) :
    tipHash p (r :: rs) = tipHash r.hash rs := rfl

/-- Append-only correctness: extending a linked chain with an `audit()`
    append keeps it linked — history is never rewritten, only extended.
    (The engine has no other write path to the audit table.) -/
theorem linked_appendRow {H : String → Ev → String} {p : String}
    {rows : List Row} (h : Linked H p rows) (e : Ev) :
    Linked H p (appendRow H p rows e) := by
  induction rows generalizing p with
  | nil =>
      cases h
      exact Linked.cons rfl rfl Linked.nil
  | cons r rs ih =>
      cases h with
      | cons hp hh hrest =>
          simp only [appendRow, List.cons_append]
          refine Linked.cons hp hh ?_
          have htip : tipHash p (r :: rs) = tipHash r.hash rs := tipHash_cons p r rs
          rw [htip]
          exact ih hrest

/-- Corollary: a chain built solely by `audit()` appends always passes
    `verifyChain` — the engine cannot produce a self-inconsistent chain. -/
theorem verifyFrom_appendRow {H : String → Ev → String} {p : String}
    {rows : List Row} (h : Linked H p rows) (e : Ev) :
    verifyFrom H p (appendRow H p rows e) = true :=
  (verifyFrom_iff _).mpr (linked_appendRow h e)

/- ============================ §3 Limits of chain verification ============================ -/

/-- Prefix property of `verifyChain`: verification of a concatenation
    implies verification of its head. Proved directly on the boolean
    recursion (ledger.ts:57-86). -/
theorem verifyFrom_init {H : String → Ev → String} {p : String} :
    ∀ rows₁ rows₂ : List Row,
      verifyFrom H p (rows₁ ++ rows₂) = true → verifyFrom H p rows₁ = true := by
  intro rows₁
  induction rows₁ generalizing p with
  | nil => intro _ _; rfl
  | cons r rs ih =>
      intro rows₂ hv
      simp only [List.cons_append, verifyFrom, Bool.and_eq_true,
        decide_eq_true_eq] at hv ⊢
      obtain ⟨⟨h1, h2⟩, h3⟩ := hv
      exact ⟨⟨h1, h2⟩, ih rows₂ h3⟩

/-- COUNTEREXAMPLE (tail truncation is undetectable): any proper prefix of
    a valid chain also passes `verifyChain`. An attacker (or a bug) that
    drops the newest audit rows leaves a chain that verifies — detection
    requires an externally anchored tip hash or row count, neither of
    which the desk persists or checks (ledger.ts:57-86; the audit route
    verifies only the rows it fetched). -/
theorem verifyFrom_prefix_of_linked {H : String → Ev → String} {p : String}
    {rows₁ rows₂ : List Row} (h : Linked H p (rows₁ ++ rows₂)) :
    verifyFrom H p rows₁ = true :=
  verifyFrom_init rows₁ rows₂ (verifyFrom_of_linked h)

/- Note (not a theorem): `verifyChain` also never inspects `seq`
    (ledger.ts:57-86 recomputes hashes from stored fields only), so
    sequence gaps or duplicates are invisible to it as long as the hash
    links hold. Recorded in NOTES.md. -/

/- ============================ §4 R0 gate (chp.ts:evaluateR0Gate) ============================ -/

/-- Inputs to the R0 criteria (chp.ts:79-118). Monetary/probability values
    are modelled as integer comparisons (the model abstracts IEEE-754;
    see NOTES.md). `scoped` is omitted: with the shipped constants it is
    computed from `checkScope("live-session-trading", …)` against fixed
    desk parameters and is true on every call the engine can make
    (chp.ts:389-394, config.ts) — flagged in NOTES.md. -/
structure R0Input where
  /-- equity > 0 (part of `solvable`, chp.ts:86) -/
  equity : Int
  /-- notional > 0 (part of `solvable`, chp.ts:86) -/
  notional : Int
  /-- side ∈ {YES, NO} (`valid`, chp.ts:100) -/
  sideValid : Bool
  /-- 0 < modelProb < 1 (`valid`, chp.ts:100) -/
  probValid : Bool
  /-- signedEdge ≠ null ∧ signedEdge > 0 (`worthIt`, chp.ts:103) -/
  edgePos : Bool

/-- R0 verdict (chp.ts:107-117): PASS iff every criterion holds. -/
def r0Pass (i : R0Input) : Bool :=
  decide (0 < i.equity ∧ 0 < i.notional ∧ i.sideValid = true ∧
    i.probValid = true ∧ i.edgePos = true)

theorem r0Pass_iff {i : R0Input} :
    r0Pass i = true ↔
      0 < i.equity ∧ 0 < i.notional ∧ i.sideValid = true ∧
        i.probValid = true ∧ i.edgePos = true := by
  simp [r0Pass]

/-- A non-positive edge can never pass R0: with no venue price the engine
    passes edge = -1 (engine.ts:534), which lands here and vetoes the
    trade before any sizing happens. -/
theorem r0_no_edge_no_pass {i : R0Input} (h : i.edgePos = false) :
    r0Pass i = false := by
  simp [r0Pass, h]

/- ============================ §5 CHP Profile B gate (@cubiczan/chp gate.js) ============================ -/

/-- Profile B policy as assembled by `chpPolicy()` (chp.ts:171-193):
    max_notional 500, daily_cap 2500, hitl_threshold 250 (all
    env-overridable), min_confidence = DESK.minConfidence = 0.6,
    allowed_actions = ["TRADE"], per-asset caps = max_notional.
    Confidence is modelled in integer points (60 ≡ 0.60). -/
structure PolicyB where
  maxNotional : Int
  perAssetCap : Int
  dailyCap : Int
  hitlThreshold : Int
  minConf : Int
  /-- action ∈ allowed_actions (gate.js hard check) -/
  actionAllowed : Bool

/-- A candidate trade as Profile B sees it (gate.js:evaluateGate).
    `committedToday` is the CHP-ledger sum of §9. -/
structure TradeB where
  notional : Int
  committedToday : Int
  /-- confidence, if the caller presented one (gate.js: absent/null
      confidence skips the min-confidence check) -/
  conf : Option Int

/-- The conjunction of Profile B hard checks (gate.js:evaluateGate):
    positive notional, allowlisted action, per-asset cap, max notional,
    daily cap, and min confidence when present. In the code these are a
    failure list; BLOCKED iff the list is non-empty — the De Morgan dual
    of this conjunction. (NaN/finiteness, a JS-only concern, is covered
    by the `notional > 0` and `≤` comparisons failing on NaN in the code;
    see NOTES.md.) -/
def HardOk (pol : PolicyB) (t : TradeB) : Prop :=
  0 < t.notional ∧ pol.actionAllowed = true ∧
  t.notional ≤ pol.perAssetCap ∧ t.notional ≤ pol.maxNotional ∧
  t.committedToday + t.notional ≤ pol.dailyCap ∧
  (match t.conf with
   | none => true
   | some c => decide (pol.minConf ≤ c)) = true

/-- The hard-check conjunction is decidable (needed for `evalB`'s if). -/
instance (pol : PolicyB) (t : TradeB) : Decidable (HardOk pol t) := by
  unfold HardOk
  infer_instance

inductive VerdictB where
  | blocked
  | hitl
  | locked
deriving DecidableEq, Repr

/-- The gate itself (gate.js:evaluateGate): hard failure → BLOCKED with
    committed_delta 0; else notional ≥ threshold → HITL_REQUIRED (the
    threshold comparison is INCLUSIVE); else LOCKED, allowed, with
    committed_delta = notional. Returns (verdict, committed_delta). -/
def evalB (pol : PolicyB) (t : TradeB) : VerdictB × Int :=
  if HardOk pol t then
    if pol.hitlThreshold ≤ t.notional then (.hitl, 0)
    else (.locked, t.notional)
  else (.blocked, 0)

/-- Master characterisation: every Profile B evaluation is exactly one
    of the three code outcomes, with the stated side conditions. -/
theorem evalB_cases (pol : PolicyB) (t : TradeB) :
    (evalB pol t = (.locked, t.notional) ∧ HardOk pol t ∧
      t.notional < pol.hitlThreshold) ∨
    (evalB pol t = (.hitl, 0) ∧ HardOk pol t ∧
      pol.hitlThreshold ≤ t.notional) ∨
    (evalB pol t = (.blocked, 0) ∧ ¬ HardOk pol t) := by
  unfold evalB
  by_cases hH : HardOk pol t
  · rw [if_pos hH]
    by_cases hT : pol.hitlThreshold ≤ t.notional
    · rw [if_pos hT]
      exact Or.inr (Or.inl ⟨rfl, hH, hT⟩)
    · rw [if_neg hT]
      exact Or.inl ⟨rfl, hH, by omega⟩
  · rw [if_neg hH]
    exact Or.inr (Or.inr ⟨rfl, hH⟩)

/-- Desk-level meaning (chp.ts:412-423): the composite gate treats only
    LOCKED as approval. So an allowed Profile B outcome certifies every
    hard check passed, the amount is strictly under the HITL threshold,
    and the committed delta is exactly the notional. -/
theorem evalB_locked_imp {pol : PolicyB} {t : TradeB}
    (h : (evalB pol t).1 = .locked) :
    HardOk pol t ∧ t.notional < pol.hitlThreshold ∧
      (evalB pol t).2 = t.notional := by
  rcases evalB_cases pol t with ⟨h1, h2, h3⟩ | ⟨h1, h2, h3⟩ | ⟨h1, h2⟩
  · exact ⟨h2, h3, by rw [h1]⟩
  · rw [h1] at h; cases h
  · rw [h1] at h; cases h

/-- HITL_REQUIRED is not an approval: at or above the threshold (with all
    hard checks passing) the verdict is HITL, which the desk refuses —
    it "cannot self-approve" (chp.ts:416-423). The threshold is inclusive,
    so a trade of exactly `hitl_threshold` (250 by default) already
    requires a human. -/
theorem evalB_hitl_of_threshold {pol : PolicyB} {t : TradeB}
    (hH : HardOk pol t) (hT : pol.hitlThreshold ≤ t.notional) :
    evalB pol t = (.hitl, 0) := by
  rcases evalB_cases pol t with ⟨h1, h2, h3⟩ | ⟨h1, h2, h3⟩ | ⟨h1, h2⟩
  · omega
  · exact h1
  · exact absurd hH h2

/-- A blocked trade commits nothing (gate.js: committed_delta = 0 on
    every hard failure), so refused trades never consume the daily cap. -/
theorem evalB_blocked_delta {pol : PolicyB} {t : TradeB}
    (h : (evalB pol t).1 = .blocked) : (evalB pol t).2 = 0 := by
  rcases evalB_cases pol t with ⟨h1, h2, h3⟩ | ⟨h1, h2, h3⟩ | ⟨h1, h2⟩
  · rw [h1] at h; cases h
  · rw [h1] at h; cases h
  · rw [h1]

/- ============================ §6 Foundation gate (chp.ts:assessTradeFoundation) ============================ -/

/-- Inputs to the foundation assessment (chp.ts:340-386). The domain is
    hardcoded "defi" in the desk, whose score floor is 85. -/
structure FoundInput where
  /-- all risk gates passed (drives the guardrails leg, +40) -/
  gatesPass : Bool
  /-- bounded-order leg facts (+30): notional finite, > 0,
      ≤ equity · perTradeEquityShare · 1.01 (+ε), ≤ policy max notional -/
  bounded : Bool
  /-- a venue book with both bid and ask exists -/
  book : Bool
  /-- parity leg facts: book values in (0,1), bid ≤ ask, model
      probability within 0.5 of the venue mid, notional ≤ equity -/
  parityOk : Bool

/-- Foundation score (chp.ts:348-372): 40 + 30 + 30 over the three legs.
    The parity leg scores 0 unless a book exists and every parity check
    passes (`state_assertions` earns nothing). -/
def foundScore (f : FoundInput) : Int :=
  (if f.gatesPass then 40 else 0) +
  (if f.gatesPass && f.bounded then 30 else 0) +
  (if f.book && f.parityOk then 30 else 0)

inductive FoundVerdict where
  | pass
  | reframe
  | halt
deriving DecidableEq, Repr

/-- Foundation verdict (chp.ts:360-385): a present-but-inconsistent book
    is a fatal HALT regardless of score; otherwise PASS iff the score
    meets the defi floor of 85, else REFRAME. The composite gate accepts
    only PASS (chp.ts:425-432). -/
def foundEval (f : FoundInput) : FoundVerdict :=
  if f.book && !f.parityOk then .halt
  else if 85 ≤ foundScore f then .pass else .reframe

/-- PASS certifies all three legs: guardrails (risk gates green),
    bounded order, and a consistent venue book. Proof by exhaustion of
    the 16 input combinations — any missing leg caps the score at
    70 < 85. -/
theorem foundEval_pass_imp {f : FoundInput}
    (h : foundEval f = .pass) :
    f.gatesPass = true ∧ f.bounded = true ∧ f.book = true ∧
      f.parityOk = true := by
  obtain ⟨g, b, bk, p⟩ := f
  cases g <;> cases b <;> cases bk <;> cases p <;>
    simp [foundEval, foundScore] at h ⊢

/-- COUNTEREXAMPLE (no book, no trade): without a complete venue quote
    the parity leg scores 0 and the maximum attainable score is
    40 + 30 = 70 < 85, so the foundation stage returns REFRAME (never
    PASS) and the composite gate refuses. Under the shipped code the
    "foundation" stage is therefore a hard dependency on live venue
    data, not a soft check. -/
theorem foundEval_no_book {f : FoundInput} (h : f.book = false) :
    foundEval f ≠ .pass := by
  intro hp
  have := foundEval_pass_imp hp
  rw [h] at this
  exact Bool.false_ne_true this.2.2.1

/- ============================ §7 Composite gate and actuation (chp.ts:runChpTradeGate, engine.ts) ============================ -/

/-- Everything the composite CHP trade gate consults (chp.ts:388-445). -/
structure GateInputs where
  r0 : R0Input
  /-- the eight deterministic risk gates, all passing (risk.ts) -/
  riskPass : Bool
  polB : PolicyB
  tradeB : TradeB
  found : FoundInput
  /-- DESK.chpRequireHumanLock (env-gated, default true; chp.ts:48-52) -/
  requireLock : Bool
  /-- mode = LIVE (PAPER is exempt from the human lock; chp.ts:434) -/
  isLive : Bool
  lockState : LockState

/-- The composite gate (chp.ts:388-445): stages run R0 → risk re-check →
    Profile B → foundation → human lock, and `allowed` holds iff every
    stage passes. (In the engine's call path the risk re-check is
    redundant — the gate is only invoked after the risk gates already
    passed, engine.ts:543-560 — but the gate function itself enforces
    it, and this model follows the gate.) -/
def compositeAllowed (g : GateInputs) : Bool :=
  r0Pass g.r0 && g.riskPass &&
  decide ((evalB g.polB g.tradeB).1 = .locked) &&
  decide (foundEval g.found = .pass) &&
  (!g.requireLock || !g.isLive || decide (g.lockState = .locked))

/-- Soundness of the composite gate: an allowed verdict certifies every
    stage — R0's criteria, all risk gates, Profile B LOCKED with all
    hard checks and the trade strictly under the HITL threshold, a
    foundation PASS with all three legs, and (when required for a live
    trade) the session lock in LOCKED. -/
theorem compositeAllowed_imp {g : GateInputs}
    (h : compositeAllowed g = true) :
    (0 < g.r0.equity ∧ 0 < g.r0.notional ∧ g.r0.sideValid = true ∧
      g.r0.probValid = true ∧ g.r0.edgePos = true) ∧
    g.riskPass = true ∧
    HardOk g.polB g.tradeB ∧ g.tradeB.notional < g.polB.hitlThreshold ∧
    (g.found.gatesPass = true ∧ g.found.bounded = true ∧
      g.found.book = true ∧ g.found.parityOk = true) ∧
    (g.requireLock = true → g.isLive = true → g.lockState = .locked) := by
  simp only [compositeAllowed, Bool.and_eq_true, decide_eq_true_eq] at h
  obtain ⟨⟨⟨⟨h_r0, h_risk⟩, h_b⟩, h_f⟩, h_lock⟩ := h
  obtain ⟨hB_hard, hB_hitl, -⟩ := evalB_locked_imp h_b
  refine ⟨r0Pass_iff.mp h_r0, h_risk, hB_hard, hB_hitl,
    foundEval_pass_imp h_f, ?_⟩
  intro hr hl
  rw [hr, hl] at h_lock
  simp only [Bool.not_true, Bool.false_or, decide_eq_true_eq] at h_lock
  exact h_lock

/-- The engine's actuation point (engine.ts:562-610): the execution
    adapter is called only on the `allowed` path, and the CHP trade
    ledger is sealed only with the gate's committed delta. Modelled as
    the value the engine acts on: `some n` (execute + seal n) vs `none`
    (refuse, no execution, no seal). -/
def engineAct (g : GateInputs) : Option Int :=
  if compositeAllowed g then some (evalB g.polB g.tradeB).2 else none

/-- No execution and no ledger seal without a fully-passing gate: any
    actuated amount certifies the composite gate passed and equals the
    trade's notional (Profile B's committed delta). -/
theorem engineAct_imp {g : GateInputs} {n : Int}
    (h : engineAct g = some n) :
    compositeAllowed g = true ∧ n = g.tradeB.notional := by
  unfold engineAct at h
  split at h
  · rename_i hcon
    simp only [Option.some.injEq] at h
    obtain ⟨-, -, hHard, hHitl, -, -⟩ := compositeAllowed_imp hcon
    have hdelta : (evalB g.polB g.tradeB).2 = g.tradeB.notional := by
      rcases evalB_cases g.polB g.tradeB with
        ⟨h1, -, -⟩ | ⟨h1, -, hT⟩ | ⟨h1, hNH⟩
      · rw [h1]
      · omega
      · exact absurd hHard hNH
    exact ⟨hcon, h ▸ hdelta⟩
  · cases h

/- ============================ §8 Desk engine lifecycle (engine.ts) ============================ -/

inductive SessState where
  | idle
  | running
deriving DecidableEq, Repr

/-- The engine, abstracted to the fields the lifecycle touches
    (engine.ts:106-135): run status, the CHP SessionLock, and the
    current session id. -/
structure Engine where
  state : SessState
  lock : Lock
  sessionId : Option Nat

/-- `start()` (engine.ts:148-200): rejected while RUNNING; otherwise a
    fresh session — cycle/PnL/audit state reset, audit chain back to
    GENESIS, and a NEW SessionLock, so every session starts EXPLORING.
    (The concrete id value is irrelevant; `some 0` stands for the row
    the code creates.) -/
def engStart (e : Engine) : Option Engine :=
  if e.state = .running then none
  else some ⟨.running, Lock.fresh, some 0⟩

/-- `stop()` (engine.ts:202-229): rejected unless RUNNING; clears the
    timer, drops to IDLE, audits SESSION_END and marks the DB session
    STOPPED. It does NOT settle or close open trades first, and it does
    not reset the lock object — the lock is only replaced by the next
    `start()`. -/
def engStop (e : Engine) : Option Engine :=
  if e.state = .running then some ⟨.idle, e.lock, none⟩ else none

/-- start is rejected while running: no double sessions. -/
theorem engStart_running {e : Engine} (h : e.state = .running) :
    engStart e = none := by
  simp [engStart, h]

/-- stop is rejected while idle. -/
theorem engStop_idle {e : Engine} (h : e.state = .idle) :
    engStop e = none := by
  simp [engStop, h]

/-- A successful start always installs a FRESH lock: lock state can never
    carry over between sessions — a new session is EXPLORING even if the
    previous one ended LOCKED. -/
theorem engStart_fresh_lock {e e' : Engine} (h : engStart e = some e') :
    e'.lock = Lock.fresh ∧ e'.state = .running ∧ e'.sessionId ≠ none := by
  unfold engStart at h
  split at h
  · cases h
  · simp only [Option.some.injEq] at h
    rw [← h]
    exact ⟨rfl, rfl, by simp⟩

/-- A successful stop lands in IDLE with no session, and from there stop
    is a no-op rejection: the STOPPED session is terminal — the engine
    exposes no transition out of it (only `start()` can create a NEW
    session, with a new id and a fresh lock). -/
theorem engStop_terminal {e e' : Engine} (h : engStop e = some e') :
    e'.state = .idle ∧ e'.sessionId = none ∧ engStop e' = none := by
  unfold engStop at h
  split at h
  · simp only [Option.some.injEq] at h
    rw [← h]
    refine ⟨rfl, rfl, ?_⟩
    simp [engStop]
  · cases h

/-- The CHP lock endpoints mutate the lock WITHOUT any engine-state or
    session check: `chpOpenProvisional`/`chpConfirm` (engine.ts:714-736)
    and their route (src/app/api/desk/chp/route.ts) never test
    `status`/`sessionId` — `audit()` silently no-ops without a session,
    but the lock mutation itself is unconditional. -/
def engChpOpen (e : Engine) : Engine :=
  ⟨e.state, (openProvisional e.lock).1, e.sessionId⟩

/-- COUNTEREXAMPLE (lock is mutable with no live session): an idle
    engine with no session at all can be driven EXPLORING →
    PROVISIONAL_LOCK, and (by §1, with any non-blank name) on to LOCKED,
    without `start()` ever being called. Combined with the route's lack
    of any authentication or approver allowlist, the "human lock" can be
    satisfied by any caller presenting any non-blank string. -/
theorem lock_mutates_while_idle :
    ∃ e e' : Engine, e.state = .idle ∧ e.sessionId = none ∧
      engChpOpen e = e' ∧ e'.lock.state = .provisionalLock ∧
      e'.state = .idle ∧ e'.sessionId = none :=
  ⟨⟨.idle, Lock.fresh, none⟩, _, rfl, rfl, rfl, rfl, rfl, rfl⟩

/-- The quiet-cycle path (engine.ts:286-297): when signal activity is
    below the quorum threshold and the cycle is not forced, the engine
    audits a heartbeat, enters cooldown and returns — settlement of
    expired trades (engine.ts:615) is on the non-quiet path only.
    Modelled on the open-trade expiry list. -/
def settleExpired (openExpiries : List Nat) (now : Nat) : List Nat :=
  openExpiries.filter (fun exp => now < exp)

/-- The quiet path leaves the open-trade list untouched. -/
def tickQuiet (openExpiries : List Nat) : List Nat := openExpiries

/-- COUNTEREXAMPLE (expired trades survive quiet cycles): an already
    expired trade is still open after a quiet cycle, even though the
    settlement step would have removed it. Expired positions therefore
    persist until the next non-quiet cycle runs. -/
theorem quiet_cycle_keeps_expired :
    tickQuiet [5] = [5] ∧ settleExpired [5] 10 = [] ∧ 5 ≤ 10 :=
  ⟨rfl, rfl, by omega⟩

/- ============================ §9 CHP trade ledger (chp-ledger.ts) ============================ -/

/-- A CHP ledger record, abstracted to the fields `checkRecord` and
    `committedToday` consult (chp-ledger.ts:59-113): the body (whose
    SHA-256 is stored alongside), the Profile B verdict, the creation
    date, and the executed notional. NOTE: the record also carries
    session/mode/fill information in the real entry — `committedToday`
    simply never filters on it, and neither does this model. -/
structure ChpRec where
  body : String
  bodySha : String
  profileLocked : Bool
  /-- created_at starts with today's UTC date string (chp-ledger.ts:108) -/
  dateOk : Bool
  notional : Int
  /-- envelope (Constitution-envelope) validity — computed by
      `checkRecord` but NOT consulted by `committedToday` -/
  envelopeValid : Bool

/-- `checkRecord`'s integrity leg (chp-ledger.ts:74-76): the stored
    digest equals the recomputed SHA-256 of the body. `D` abstracts
    SHA-256. -/
def integrityOk (D : String → String) (r : ChpRec) : Bool :=
  decide (D r.body = r.bodySha)

theorem integrityOk_iff {D : String → String} {r : ChpRec} :
    integrityOk D r = true ↔ D r.body = r.bodySha := by
  simp [integrityOk]

/-- `committedToday` (chp-ledger.ts:104-113): sum of executed notionals
    over records that are integrity-valid, dated today, and sealed with
    Profile B state LOCKED. Append is the ledger's only write
    (chp-ledger.ts:47-52) — it performs no gate check itself; gating
    lives entirely in the engine path of §7. -/
def committedToday (D : String → String) : List ChpRec → Int
  | [] => 0
  | r :: rs =>
      (if integrityOk D r && r.dateOk && r.profileLocked
       then r.notional else 0) + committedToday D rs

/-- Append-only accumulation: appending records at the tail adds exactly
    the appended records' contributions — history is never rewritten,
    matching the JSONL append in `append()` (chp-ledger.ts:47-52). -/
theorem committedToday_append {D : String → String} :
    ∀ a b : List ChpRec,
      committedToday D (a ++ b) = committedToday D a + committedToday D b := by
  intro a
  induction a with
  | nil => intro b; simp [committedToday]
  | cons r rs ih =>
      intro b
      simp only [List.cons_append, committedToday]
      rw [ih]
      omega

/-- COUNTEREXAMPLE (envelope validity is not a committed-spend
    condition): a record whose envelope is INVALID still counts toward
    the daily committed total, as long as its body hash matches, it is
    dated today, and it is marked Profile-B LOCKED — `committedToday`
    checks `integrity_valid` only (chp-ledger.ts:104-113), never the
    `envelope_valid` that `checkRecord` computes. -/
theorem committed_counts_envelope_invalid (D : String → String) :
    committedToday D [⟨"body", D "body", true, true, 100, false⟩] = 100 := by
  simp [committedToday, integrityOk]

/-- COUNTEREXAMPLE (integrity is the only cryptographic check): a record
    counts iff its stored digest matches the recomputation — a record
    with a mismatched digest contributes nothing, but ANY body whose
    digest was correctly computed counts, whatever it says: the sum
    trusts `execution.notional` inside the sealed body and re-derives
    nothing about gates, session, mode, or fill status
    (chp-ledger.ts:104-113). -/
theorem committed_ignores_bad_digest (D : String → String) (b : String)
    (h : D b ≠ "deadbeef") :
    committedToday D [⟨b, "deadbeef", true, true, 100, true⟩] = 0 := by
  simp [committedToday, integrityOk, h]

end DreamDesk
