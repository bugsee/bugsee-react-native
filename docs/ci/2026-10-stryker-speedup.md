# Stryker mutation gates: speed-up report (2026-10)

Scope: `stryker.src.json`, `stryker.scripts.json`, `stryker.plugin.json`, run as sharded jobs by
`.github/workflows/mutation-gate.yml`. Constraint: what the gates measure does not change (thresholds,
`mutate`, `ignoreStatic`, `excludedMutations` untouched), and only changes that are exact are adopted.

Data: `ci` run 39645042331 (PR #163 head, all three gates; per-shard logs and JSON reports), plus local
slice runs (host heavily loaded, so compared by CPU time and counts, never wall-clock) and one CI A/B of a
333-mutant src slice (`stryker ab` run 39753807710, throwaway branch, deleted).

## 1. Where the time goes

| Gate (shards) | Shard run times (min) | Why |
|---|---|---|
| src (6) | 7.5, 7.9, 9.8, 16.7, 18.5, 19.9 | equal mutant counts (~1300), unequal cost per mutant: ~1.4 s (plain modules) vs ~3.5 slot-s (`secure/`, `viewtree/`) |
| scripts (3) | 1.1, 1.2, **17.9** | shard 3 is `raw-messages.ts` (1485 mutants, 84% of the gate's time); the other 8 shards' worth of files take ~1 min together |
| plugin (10) | 3.7 to 19.9 | gradle lexer and the hermes scripts dominate; the planner's `OVERSIZED_COST` hack covers the lexer only |

Per-mutant cost is not test time (a whole src suite runs in a few seconds): it is one Jest run per mutant
plus whatever the covering tests do on a mutated path. Wall-clock timeouts are rare: src 4 in total (one
shard), scripts 11 (one shard), plugin 75. Infinite loops are caught by Stryker's hit limit
(`Hit limit reached`), not by `timeoutMS`.

## 2. Candidates

| # | Candidate | Verdict | Evidence | Expected saving | Risk |
|---|---|---|---|---|---|
| 4 | Rebalance by estimated cost per file (`GATE_COSTS`) | **Adopted** (src, scripts) | Fit of shard time to per-directory costs: 7.5% rms error on src's 6 shards vs 2.5x spread unweighted. Local `plan` shows cost-equal shards. Partition tests: every mutant in exactly one shard for any costs | scripts critical shard 18 -> ~7 min; src slowest 20 -> ~13 min (model; confirmed or corrected by the PR's CI run) | Stale costs only unbalance shards, never lose a mutant; merge still checks the mutant count against the plan |
| 5a | `--concurrency` 4 vs 3 vs 6 on a 4 vCPU runner | Rejected (4 is right) | CI A/B, same 333 mutants, identical results (same fingerprint): c3 438 s, c4 284 and 371 s (two controls), c6 522 s | none | - |
| 5b | `inPlace` for src/scripts | Rejected | A/B: 289 s vs 284/371 s control, no gain (copying 584 files is cheap). inPlace also rewrites file modes (it flipped the exec bit of 5 tracked scripts locally, hence `mutate:plugin`'s chmod) | none | exec-bit side effects |
| 3 | Lower `timeoutMS` (src 30000) | Rejected | src has 4 wall-clock timeouts in the whole gate, in one non-critical shard: <= 40 s of runner time. Hit-limit timeouts do not wait `timeoutMS`. Scripts: 11, ~100 s on the shard being split anyway. Only plugin has enough (75) and its break is 97 | <= 1 min | A lower value can only turn slow kills into timeouts, but a loaded runner could mis-time-out a legit test |
| 2 | swc / other jest transform | Rejected | A cold jest run costs 17 CPU-s more than a warm one over src+scripts together (`--no-cache`: 39.7 vs 22.8 CPU-s); each Stryker worker pays at most that once. Per-mutant time is not transform time (a mutant reuses the instrumented, cached module). The scripts and src configs already use ts-jest `isolatedModules` with diagnostics off | ~5-10 s per shard (1%) | decorators, const enums, hoisting differences for no gain |
| 5c | Jest cache persistence, `watchman: false`, heap size, clear-text reporter | Rejected | watchman false: -2% CPU, inside run-to-run noise (126 vs 125 CPU-s); jest cache key includes the sandbox's rootDir, so a restored cache would not hit, and cold transform is <= 1%; clear-text prints once at the end | ~0 | - |
| 1 | `--incremental` with a cached report from main | **Rejected for PR gates; not exact** | see section 3 | would be large on small diffs | unsound reuse (3a), scope carry-over (3b), plan drift (3c) |

## 3. Why incremental mode cannot be made exact here

Stryker 10's `IncrementalDiffer` reuses a mutant's old result when its own code region is unchanged and,
for a killed mutant, the killing test's source is unchanged and still covers it; for a survivor, no test was
added. Compared with a full run:

a. **Unsound across files.** Nothing looks at a *third* file. Edit module X so that test T no longer
   exercises a branch of Y (tests still green): Y's mutants stay "Killed by T" from the cache while a full
   run reports survivors. The gate would pass a change that the full gate fails. Same for test helpers,
   mocks, jest config and `package.json` (not tracked by the report; they would have to go in the cache
   key, and then any such PR misses the cache). A sound key (hash of everything a shard can read) changes
   on every PR that touches the gate, so it only helps PRs the scope filter already skips.
b. **Scope carry-over, measured.** Run 1 mutates `secure/hold.ts` (73 mutants, 56 s); run 2 reuses 73 of
   73 (4 s). Run 3 mutates only `errorName.ts` with the same incremental file: the report holds
   `hold.ts` (73) **and** `errorName.ts` (26): old mutants outside the run's `mutate` are carried into the
   report. With sharding, whenever a shard's slice moves (a file added or edited shifts the cuts), its
   cached report carries mutants of the old slice and the merge count check (`the shards reported N
   mutant(s), the plan has M`) fails, unless the merge also filters each report to its shard's plan.
c. **Plan drift.** Shard i's cache only helps while shard i has the same slice; a mutant that changes
   shard re-runs in full.
d. Cache policy: PRs can only read main's cache (saved on push), so a PR's own earlier runs never help.

If the maintainers accept approximate PR gates with an exact full run on every push to main (and a
nightly), the design would be: per gate+shard `actions/cache` (key = hash of config, lockfile and plan;
restore-keys prefix; saved only on `push`), `--incremental --incrementalFile`, and `merge` filtering each
report to its shard's own keys before the count check. Not implemented: it breaks "identical score".

## 4. Adopted change

`planShards(files, n, costs)` cuts and sizes oversized groups by cost; `GATE_COSTS` holds the per-gate
path-prefix costs (src: `secure/` 2.75, `viewtree/` 2.25, `exceptions/` 1.5; scripts: `raw-messages.ts` 16;
plugin: none). A plan with every cost 1 is the old plan (tested). `plan`/`shard` print each shard's cost.
Recalibrate when a gate's shards drift apart: compare each shard's "Done in" with its planned mutants.

Not done: plugin costs. Its CI plan differs from main's current one and one shard's per-file times are
not separable (shard 1: bundle-phase, dsym-script, endpoint at ~3.4 s wall per mutant vs ~0.5 for the
hermes scripts); a table fitted from one run would be guesswork. Follow-up once a post-merge run exists.
