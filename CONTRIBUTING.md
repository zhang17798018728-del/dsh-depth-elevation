# Contributing

Thanks for looking. This plugin is small on purpose — the goal is the shortest
code that enforces the rule, not a framework.

## Development setup

```sh
git clone https://github.com/zhangqi369/dsh-depth-elevation.git
cd dsh-depth-elevation

# The plugin has no dependencies of its own: @deepseek-ai/* are peers the
# harness supplies at runtime. Two ways to get them locally:
python tools/bootstrap-peers.py    # extract from an installed harness (exact)
node  tools/stub-peers.mjs         # or minimal stubs (no harness needed)

npm test
```

`bootstrap-peers.py` gives you the real peer versions and is what you want when
checking behaviour against the actual harness. `stub-peers.mjs` is for CI and
for contributors without a local harness install; the stubs satisfy the import
graph but are not an emulation of the runtime.

## Layout

| Path | What lives there |
|---|---|
| `lib/decide.js` | Pure decision core — no I/O, no clock, no process state |
| `lib/index.js` | `apply()` — the seam wiring and context injection |
| `test/decide.test.mjs` | Curated cases, config knobs, real-history replay |
| `test/apply.test.mjs` | Seam registration, provenance, dedupe, prompt preservation |
| `test/e2e.mjs` | A realistic multi-message batch through the seam |
| `tools/` | Peer bootstrapping, verification, asar extraction |
| `tools/dev-local/` | Machine-specific repair scripts (not part of the package) |

## Rules of the codebase

**Keep the decision core pure.** Everything in `lib/decide.js` must be a pure
function of `(text, config)`. That is what lets `test/decide.test.mjs` replay
real conversation history against the shipping matcher instead of a
reimplementation. Adding I/O there destroys the strongest test we have.

**Never return `reject` from pre-step.** `PreStepDecision.reject` drops the
user's own message. A missed offer is recoverable; a lost prompt is not. If you
need to block something, explain why in a review before writing it.

**A skipped test layer must never read as a pass.** If the replay cannot run,
the suite fails. If there is genuinely no corpus (CI), it prints a skip and does
not claim the replay happened. Keep that distinction.

**One gate per session.** Re-asking on every follow-up makes the feature
unusable; there was a version that fired 4 times in one 24-turn session.

## Before opening a PR

```sh
npm test                          # all three suites
python tools/verify_elevation_plugin.py   # mount + workspace-is-source checks
```

The second command needs a local DeepSeek Harness install and checks the things
CI cannot: that the plugin is actually mounted in a profile, and that the runtime
path is a live junction to your working tree rather than a stale copy.

## Adding a trigger

Triggers live in `DEFAULT_VERBS` in `lib/decide.js`, and every addition should be
justified by a real miss:

1. Find a real prompt that should have been gated and was not.
2. Add the verb or rule.
3. Confirm the replay's `pass` list no longer contains it, and that the ack cases
   still stay exempt.

Over-firing is the failure mode users notice: an offer on every "继续" trains
people to ignore the question entirely.
