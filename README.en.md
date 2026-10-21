# dsh-depth-elevation

**Turn your "ask before you build" rule from a prompt convention into harness-level enforcement.**

English | [中文](README.md)

---

## The problem

You wrote a rule into `AGENTS.md` that goes roughly:

> When the user raises a task with room for depth, proactively ask whether to rebuild it at expert level.

It does not work. Not because the model cannot read it — it reads it every single turn — but because **a prompt rule has no forcing function**. Every turn, the model is free to decide the task is too small to bother.

Measured over 62 real sessions from a local dsh session store:

| Metric | Value |
|---|---|
| Substantive tasks that should have triggered | 24 |
| Times the model actually asked | **1 independent task** |
| Fire rate | ~4% |

The model's own reasoning, verbatim:

> *"skip the elevation offer to avoid annoying"*

It knows the rule. It decided not to follow it.

## What this does

A native Cordis plugin that patrols the `agent/pre-step` seam:

```
user input → [plugin: does it match a hard trigger?]
                    ↓ yes
          append a sourced instruction to the entering batch
                    ↓
          the model's first action must be ask_user_question
```

The design decision that matters: **`additionalContext` semantics, never `reject`.**

`PreStepDecision.reject` **drops the user's own message**. A missed offer can be corrected on the next turn; a lost prompt cannot be recovered. That trade-off is deliberate.

## Result

Measured on this machine's real corpus:

| Metric | Result |
|---|---|
| Claimed batches reconstructed | 467 (127 sessions) |
| Gate fires that really happened | 25 |
| Reproduced + explained | 419/467 (90%) |
| Unexplained misses | **0** |
| False positives in armed workspaces | **2/467 (0.4%)** |

The two explanations are both defects this audit fixed: 5 are subagent / non-human
batches the plugin now correctly skips, and 1 is a duplicate offer (the old latch was
keyed on the Agent object, so a resume re-fired).

An earlier version of this file quoted a "match rate" as the result. That is a hit
rate — not a compliance rate, not a success rate. The number that matters is the
false-positive rate on the last line.

Run `node test/decide.test.mjs` to see the numbers for *your* machine. The replay
reads your local session store — not a fixture — reconstructs the **claimed batch**
(`inbox.claim()`, the array `pre-step` really hands the plugin) from the durable
`agent/inbox/spliced` events, and cross-checks its verdict against the gate fires that
actually happened. Unexplained misses must be zero or the suite fails.

The injected instruction now names the clause that fired (e.g. `(b:设计)`,
`(c:material)`) instead of asserting a generic "hard trigger". That lets the logs, the
model, and you tell a real semantic trigger from a regex that happened to hit a path.

## Install

```sh
git clone https://github.com/zhang17798018728-del/dsh-depth-elevation.git
```

```cmd
:: 2. Link into the profile (bundle form, no dependency declaration needed)
mklink /J %USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-depth-elevation ^
      path\to\dsh-depth-elevation

:: 3. Add to bundles — edit the profile's package.json
::    "dsh": { "profile": { "bundles": [ ..., "dsh-depth-elevation" ] } }

:: 4. Restart DSH
```

On Linux/macOS, replace `mklink /J` with `ln -s`.

### Working on it

The junction points straight at your clone, so edits take effect with no copy or rebuild:

```sh
python tools/bootstrap-peers.py    # once: extract peers from an installed harness for offline tests
npm test
```

Then open a new session to verify — the plugin loads at session start.

## Configuration

Every key can be overridden in the profile's `cordis.patch.yml`:

```yaml
- id: depth-elevation
  config:
    enabled: true                      # master switch
    verbs: ['设计', '方案', '分析']     # trigger verbs
    exemptPrefix: ['改成', '换成']      # follow-up edits (<=30 chars only)
    minChars: 6                        # single-point query ceiling
    listMinChars: 40                   # minimum length for a list to count as clause (a)
    materialMinChars: 150              # pasted-material threshold
    deliverableMinChars: 20            # deliverable-request threshold
```

> The default `verbs` and exemption lists are Chinese, because the rule this plugin enforces was written for Chinese-language work. Override them for other languages.

## Verification

```sh
npm test
```

Four suites, each aimed at a different failure mode:

| Suite | What it checks | Assertions |
|---|---|---|
| `decide` | Matcher: 18 curated cases, policy guards, and a replay of real **claimed batches** cross-checked against what actually fired on disk | 18 + guards + replay |
| `apply` | Wiring: seam registration, provenance, user prompt untouched, one gate per session | 9 |
| `e2e` | A realistic multi-message batch: ordering, provenance, downstream reject passthrough | 7 |
| `regress` | What the plugin promises about itself: linear time, session-level dedupe, subagent skip, reject recovery | 11 |

The decision logic lives in `lib/decide.js` as a pure function, so **the verifier exercises the shipping code**, not a reimplementation of it.

Running offline needs the peers (the harness supplies them at runtime); extract them once:

```sh
python tools/bootstrap-peers.py
```

The history replay only runs where a local dsh session corpus exists. With no corpus (CI) it prints a skip; with a corpus that cannot be decoded it **fails** — a skipped layer must never read as a pass.

## Audit

`docs/AUDIT.md` records a full audit (2026-10-21): 148 real transcripts replayed, 16 mutation-tested defects, harness contract decompiled. Verdict: the premise holds (the model complied 100% of the time, versus 4% under prompt-only), but the suite killed only 37.5% of mutations and there were 1 P0 performance defect and 3 P1 logic defects — all fixed, with `test/regressions.mjs` guarding them.

## Known limitations

- A human prompt is judged once per session, not per follow-up. Steps without new human input never gate.
- Subagent sessions are never gated: the harness refuses human interaction from a live child, so an offer there could only burn a turn.
- Judgement is textual heuristics, not semantic understanding.
- It errs toward asking once too often rather than skipping silently. That is intentional.

## Related

The idea behind the elevation question comes from the "Ambition, Altitude & Depth" framing — if you want the reasoning framework itself rather than the enforcement, see the `ambitious-depth` skill that ships with this setup.

## License

[MIT](LICENSE)
