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

The same real-history sample, judged by the plugin (numbers grow as more sessions
accrue; this is a snapshot at time of writing):

| Metric | Result |
|---|---|
| Substantive tasks gated | ~71% (20/28 when written) |
| Session coverage | 14/16 when written |
| The silent passes | Single-point questions and follow-ups (correctly exempt) |

Run `node test/decide.test.mjs` to see the numbers for *your* machine — the replay
reads your local session store, not a fixed fixture.

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
    exemptExact: ['继续', '好']         # exact exemptions
    exemptPrefix: ['改成', '换成']      # prefix exemptions (follow-up edits)
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

Three suites, each aimed at a different failure mode:

| Suite | What it checks | Assertions |
|---|---|---|
| `decide` | Matcher: 18 curated cases, config knobs actually take effect, replay of real history | 18 + 3 + replay |
| `apply` | Wiring: seam registration, provenance, user prompt untouched, one gate per session | 9 |
| `e2e` | A realistic multi-message batch: ordering, provenance, downstream reject passthrough | 7 |

The decision logic lives in `lib/decide.js` as a pure function, so **the verifier exercises the shipping code**, not a reimplementation of it.

Running offline needs the peers (the harness supplies them at runtime); extract them once:

```sh
python tools/bootstrap-peers.py
```

The history replay only runs where a local dsh session corpus exists. With no corpus (CI) it prints a skip; with a corpus that cannot be decoded it **fails** — a skipped layer must never read as a pass.

## Known limitations

- Only the first prompt of a turn is judged; a session is gated once, not per follow-up (an earlier stateless version fired 4 times in one 24-turn session).
- Judgement is textual heuristics, not semantic understanding.
- It errs toward asking once too often rather than skipping silently. That is intentional.

## Related

The idea behind the elevation question comes from the "Ambition, Altitude & Depth" framing — if you want the reasoning framework itself rather than the enforcement, see the `ambitious-depth` skill that ships with this setup.

## License

[MIT](LICENSE)
