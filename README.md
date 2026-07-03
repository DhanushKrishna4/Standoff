# Standoff — the "what do we watch" deadlock breaker

Two to four people, four different tastes, one screen. **Standoff** takes what each
person is in the mood for and settles the argument — then explains exactly *why* it
picked what it picked, who compromised, and what came second. It also remembers
across nights, so the same person doesn't quietly lose every single time.

It is **not** another recommender. A recommender guesses what *you* will like.
The hard, interesting problem here is the opposite: given several people who like
genuinely different things, produce **one** outcome that is legitimate, fair, and
explainable. That's a social-choice problem, and the merging/tie-breaking logic is
the whole point of this project.

```
open index.html          # solo mode — no build, no dependencies (works offline;
                         # web fonts enhance the type when you're online)
```

**Live rooms** — everyone on their own screen, same wifi, verdict on all at once:

```
node server.js           # then open http://localhost:4173 and "Start a live room"
                         # share the 4-letter code; each person joins on their phone
```

Tests (no dependencies, either):

```
node engine.test.js      # the decision engine — 19 tests
node server.test.js      # the live-rooms backend — 7 tests (spawns the server)
```

You can curate tonight's actual shortlist (add your own titles, drop what you can't
stream, mark what you've seen), save and switch between **named crews** (each with
its own fairness ledger), and either **copy a setup link** or spin up a **live room**
so everyone sets their own taste privately on their own device.

---

## The part everyone glosses over

Ask a group "what do we watch" and the usual "solutions" are:

| Approach | What actually happens |
|---|---|
| **Average everyone's rating** | Tyranny of the lukewarm. The film everyone finds *"fine"* beats the one three people love and one can live with. And a single strategic 0/10 swings the whole room. |
| **Most upvotes / highest total** | Ignores *intensity*, and reliably leaves the minority miserable night after night. |
| **Loudest person decides** | Not a system. That's the status quo you're trying to escape. |

Averaging is a **utilitarian** rule — it maximises the *total*. But for a shared
couch the goal isn't the highest average, it's that **nobody has a bad night**, and
that fairness holds up *over time*. That reframing drives every decision below.

---

## How the engine decides

All the logic is a **pure function** in [`engine.js`](engine.js):
`resolve(crew, catalog, options, memory)`. No I/O, no globals, and no randomness
except a seeded coin flip — so every verdict is reproducible and testable.

It runs in five stages.

### 0 · Feasibility — some things are simply off the table
A **veto** is a hard *no*: that genre is gone, no matter how much everyone else
wants it (`Horror` vetoed → every horror title disappears). Per-person **runtime
caps** filter too. Vetoes are sacred; a runtime cap will only *stretch* if it would
otherwise leave the menu empty — and when it does, the verdict says so.

### 1 · Per-person utility, on a level playing field
Each person gets a taste score for every surviving option, from three ingredients:

- **genre** — the strongest signal (`love / like / neutral / dislike`), rewarding
  both hitting something you love *and* broad fit;
- **mood** — closeness between tonight's requested mood and the film's tone across
  three axes (*switch-off↔think*, *cozy↔intense*, *serious↔light*);
- **quality** — a gentle nudge toward well-made things, deliberately low-weighted.

Those scores are then **normalised within each person** (min–max over the feasible
menu). This kills the classic interpersonal-comparison trap: someone who rates
harshly (2–5) can't dominate someone generous (8–10) just by using a different
scale. Everyone's best feasible option becomes 1, their worst 0.

### 2 · Group metrics — several lenses, not one
For each option we compute a small panel of well-understood social-choice measures:

- **Floor** (Rawls / egalitarian) — how happy is the *least*-keen person? Weighted
  highest, because avoiding a bad night matters most.
- **Welfare** (utilitarian) — mean satisfaction.
- **Nash product** — the classic bargaining solution; balances efficiency and
  fairness by rewarding options that are decent for *everyone* multiplicatively.
- **Copeland score** (Condorcet) — how many other options does it beat in a
  majority head-to-head? A score of 1 is a **Condorcet winner**: it beats
  *everything* — the strongest possible mandate, and a great line to explain with.
- **Disagreement** — penalises polarising, love-it-or-hate-it options.

### 3 · Fairness memory — the actual deadlock-breaker over time
This is what turns a recommender into a *fair* group tool. The engine tracks each
person's **cumulative satisfaction** across every night this crew has locked in.
"Debt" is simply how far a person sits below the group's *average lifetime
satisfaction* — i.e. who's had the rawer deal over time. Deriving it from running
totals (rather than summing per-round shortfalls) makes it self-correcting by
construction: once someone has caught up on good nights, their debt is zero, no
bookkeeping required.

That debt becomes a **signed** thumb on the scale next time:

- **positive** for options where an owed person does *better* than that option's
  own average (a chance to pay them back), and
- **negative** for options where they'd be the sacrifice *again*.

Crucially, it's **gated by safety**. Fairness is only allowed to move things among
options that keep *everyone* about as happy as the best achievable floor. An option
that would strand a *third* person earns little or no fairness boost — so "whose
turn is it" can decide between genuinely good options, but can **never** repay one
person by making someone else miserable. (This is easy to see in the code: the
`safety` factor in `composite()` multiplies the fairness term toward zero as an
option's floor drops below the field's best.)

A little unfairness barely registers; sustained unfairness saturates the effect —
but the safety gate and the heavily-weighted floor mean taste always stays in
charge.

### 4 · Composite + an honest tie-break ladder
The metrics combine into one composite score. Genuine near-ties (within a small
epsilon) are then settled by a **transparent, ordered ladder**:

1. higher floor (protect the least-happy),
2. more head-to-head wins,
3. better Nash balance,
4. least polarising,
5. who's owed.

If it's still a true dead heat, it uses a **seeded coin flip and says so** —
because inventing a reason for a 50/50 call would be dishonest.

### 5 · Explanation — no black box
Every verdict comes back in plain language: the pick, a one-line rationale keyed to
the metric that actually distinguished it, a per-person satisfaction read-out, who
compromised (and the promise to make it up to them), the **runner-up and the exact
reason it lost**, anything ruled out by a veto or the clock, and the full ranked
field visualised (each person is a dot; the bright tick is the least-happy floor).

### The five-method cross-check — how legitimate is this, really?
The composite above is one considered blend. But any single rule can quietly embed
one bias, so Standoff also asks the **five canonical aggregation methods** — which
each encode a genuinely different philosophy of fairness — to vote independently:

| Method | Philosophy |
|---|---|
| **Utilitarian** | greatest total satisfaction |
| **Egalitarian** (maximin) | help the worst-off (Rawls) |
| **Borda** | ranked-choice; robust to clones |
| **Copeland / Condorcet** | wins the most head-to-heads |
| **Nash** | maximise the product (bargaining solution) |

When four or five agree, that's about as objective as group choice gets, and the
verdict says "strong consensus." When they split — or when there's **no Condorcet
winner at all** (a genuine preference *cycle*, the rock-paper-scissors of taste) —
the verdict shows you the disagreement honestly rather than hiding it behind one
number, including a **head-to-head matrix** of the finalists and the exact cycle
("A beats B, B beats C, yet C beats A"). It's both a confidence signal and the most
educational part of the output.

### Is the verdict solid — and could it be gamed?
Two questions a serious group-decision tool should answer, both computed by
re-resolving hundreds of hypothetical profiles (so they're exact for the mechanism,
not hand-waving):

- **Robustness.** Would any *single small change of heart* flip tonight's pick? The
  engine stress-tests every one-step genre change from every person and reports the
  fraction that leave the result unchanged — plus the **pivotal counterfactual**
  when it's close ("if Maya warmed to Comedy, you'd be watching *The Nice Guys*").
- **Strategyproofness.** Could anyone get a better night by *misreporting* their
  taste? Gibbard–Satterthwaite proves no reasonable rule can be immune in general,
  so the honest, valuable thing is to check *tonight's* profile against the standard
  manipulations (bury the winner, boost your favourite, extremise) and say plainly
  whether it held — and if not, who could have gamed it and toward what.

This is the part that surfaces the deepest truth of the whole project: the option
that wins the most head-to-heads is often *not* the fair pick, because it strands
someone — and the verdict says so, out loud, with the numbers to back it.

---

## Design decisions & trade-offs

- **Floor over average.** The single most important choice. Weighting the
  least-happy person highest is why Standoff won't pick the polarising crowd-
  splitter even when it has the best average.
- **Normalise within person.** Without this, the merge is hostage to whoever rates
  on the widest scale. It's the difference between "fair" and "fair-looking."
- **Fairness is signed *and* safety-gated.** An earlier version simply lifted
  options an owed person liked in absolute terms — but an option can be
  everyone's-fine and still stiff the same person every week. The signed form moves
  *away* from repeat sacrifices; the safety gate stops it from creating a new
  victim. Together they let the fairness weight be assertive without ever being
  unfair.
- **Honesty about ties.** A declared coin flip builds more trust than a
  manufactured justification. The engine would rather say "genuine dead heat."
- **Consensus beats rotation.** If a genuine bridge film exists that everyone
  enjoys (a near-Condorcet winner), Standoff keeps choosing it and nobody accrues
  much debt — which is correct. Fairness rotation kicks in precisely when the best
  option keeps leaving the *same* person behind and a comparably-safe alternative
  exists.

---

## Using it for your actual options

It's a real tool, not a fixed menu:

- **Curate tonight's pool.** Open *Tonight's options* to drop titles you can't
  stream, filter by title/genre, and **add your own** — give it a name, genres, a
  runtime and a vibe, and the engine scores it exactly like everything else.
- **"Seen it."** Mark a title as watched-together (in the pool, or straight from a
  verdict with *We've seen it*). It's remembered per crew and quietly kept out of
  future picks, so you never get handed the same rewatch twice. Unmark to allow it.
- **Share a setup.** *Copy setup link* encodes the whole session — crew, tastes,
  pool, custom titles — into a URL. Send it round and everyone can tweak their own
  taste on their own phone. No accounts, no server; open the link and it rehydrates.

---

## Files

| File | What it is |
|---|---|
| [`engine.js`](engine.js) | The merging & tie-breaking engine: utility, group metrics, the five-method panel, safety-gated fairness, tie-break ladder, Condorcet-cycle detection, robustness + strategyproofness analysis, explanation. Pure, dependency-free, dual-exported for Node + browser. **This is the interesting bit.** |
| [`engine.test.js`](engine.test.js) | 19 tests: hand-checked group metrics, the egalitarian property, scale-invariance, signed fairness, cumulative debt accounting, veto/runtime/seen handling, determinism, method-panel divergence + Condorcet detection, cycle detection, and self-consistent robustness + strategyproofness checks. |
| [`catalog.js`](catalog.js) | An editorial catalog (~46 films & series) with genres, runtimes and authored mood/quality attributes. Swap in your own library and nothing else changes. |
| [`app.js`](app.js) | UI, state and `localStorage` persistence. Clean onboarding (blank seats + "load an example crew"), **first-class crews** (save / name / switch, each with its own ledger), the editable candidate pool, the skippable split-flap reveal, the verdict with its deep analysis behind progressive disclosure, an **interactive counterfactual** ("tug on a preference and watch the pick flip, live"), copyable verdicts, shareable setup links, synthesized **sound design**, and the motion layer. |
| [`index.html`](index.html) · [`styles.css`](styles.css) | An editorial, stripped-back identity — a bold projector-lit hero in Fraunces (with a marquee ticker + cursor glow), numbered sections, film grain, and a Solari split-flap "now showing" reveal (with Web-Audio "clack" + chime, muteable). Reveals use `IntersectionObserver` (robust, not animation-frame-gated); fully responsive; honours `prefers-reduced-motion`. |
| [`server.js`](server.js) | **Live-rooms backend** — pure Node stdlib, no dependencies: serves the app *and* runs a hand-rolled WebSocket server (RFC 6455). Rooms, presence (tastes stay private until the reveal), host-only controls, the engine as the server-side source of truth, and per-room fairness ledgers persisted to disk by code. |
| [`server.test.js`](server.test.js) | 7 tests driving the backend with real WebSocket clients: create/join, private presence, one identical broadcast verdict, host-only enforcement, ledger persistence, and disconnect handling. |
| [`serve.py`](serve.py) | A tiny no-cache static server, for solo live-editing only. Not needed to use the app. |

## Testing

```
node engine.test.js
```

The suite pins the properties that matter — including that a symmetric two-person
standoff is an honest coin flip **until** fairness memory is given a reason to
decide it, that utilitarian and egalitarian genuinely diverge (and the Condorcet
winner is detected), and that a "seen" title is dropped and explained. Because the
engine is deterministic, these are exact assertions, not snapshots.

## Extending it

- **Your own library:** replace the array in [`catalog.js`](catalog.js). Each entry
  needs `genres`, `runtime`, the three mood attributes (`brain`, `intensity`,
  `levity`, each `0..1`) and a `score`. The engine is agnostic to the data source.
- **Tune the values:** every weight and threshold lives in `WEIGHTS` at the top of
  [`engine.js`](engine.js), documented inline, so the value judgements are legible
  and adjustable in one place.

## Honest limitations

- The mood/quality attributes are *authored*, not learned — this is a decision
  engine, not a data pipeline. Point it at real ratings and it behaves identically.
- **Live rooms** work out of the box on one machine or a shared wifi (the host runs
  `node server.js`; everyone opens the host's address). To use them across the open
  internet you'd deploy `server.js` to any Node host — no code changes, just a URL.
  Solo mode needs nothing but the file.
- Crews are first-class: save several ("Movie Club", "Family", "Date night") and
  switch between them, each with its own fairness ledger. Memory and the "seen"
  list live in `localStorage` keyed by a stable crew id (not names), so renaming a
  person no longer orphans the ledger.
- Setup links carry the crew and pool but not the fairness ledger — the ledger is
  private to each device, by design (it's a record of *your* nights).
- The strategyproofness check tests the *standard* manipulations (bury the winner,
  boost your favourite, extremise), not the entire space of possible lies — so
  "strategyproof tonight" means "no obvious way to game it," not a formal proof of
  immunity (which Gibbard–Satterthwaite rules out anyway). It errs toward honesty.
- With only three mood axes and coarse genre stances, two very different films can
  look similar to the engine. More axes would sharpen it; these three keep taste
  entry to about fifteen seconds per person, which matters more for actual use.
