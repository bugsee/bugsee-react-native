# CI speed-up research (2026-10)

Scope: `bugsee/bugsee-react-native` pull-request checks. Data: 13 recent PR runs of `ci`
(run ids 39549035751 .. 39641094099, 2026-10-21) plus the `playground`, `Claude PR Review`
and `campaign windows hermes` runs next to them, read with `gh api .../actions/runs/<id>/jobs`.
Numbers are minutes. "queue" = `started_at - created_at` of a job; "run" = `completed_at - started_at`.

## 1. Where the time goes

**The 20 minutes is only the uncontended case. Measured wall-clock (first job created to last job
finished) of full `ci` runs was 31, 34, 44, 45, 53, 61, 66, 69 min (median ~49).** The run time
of the longest chain is 19-36 min; the rest is queue.

| Cause | Evidence |
|---|---|
| Queue (runner contention) | Median queue per job 0-20 min, max 49 min. macOS jobs wait longest (median 3-40 min per run). The repo is public, so these are GitHub-hosted runners with a concurrent-job cap (the plan's limit is not visible through the API): every extra job is another wait, and other PRs (#161/#162 pushes) compete for the same pool. |
| `mutation (src)` run time | 4 shards, run 22-36 min each, 1 of the 4 is always >=22 min; shard 1 is ~14. It is the critical path whenever `src` is touched (most PRs). |
| `mutation (scripts)` imbalance | 3 shards: 1.5 / 2.3 / **11-19** min. One shard is 5-10x the others (balanced by mutant count, not cost). |
| `mutation (plugin)` | 10 shards, 4-21 min, median 8. Runs only when plugin/hermes-script files change. |
| macOS job bodies | `ios e2e` 12-16 (pods 4-5.5, simulator boot 1.7-2.2, build ~2.3), `ios (cocoapods)` 5.7, `ios (spm)` 4.1, `ios unit` 3.6, `pack install ios` x2 2-3. |
| Android | `android` 9-12 (Gradle assemble 7 of it, cold ~/.gradle every time). |
| Setup repeated per job | `yarn install --immutable` runs in 15 jobs (ubuntu 36-37 s; macOS 64-117 s) with no cache of any kind. Every shard repeats it. |

### Current check inventory (a PR that touches src + scripts: 39 checks; all three gates: 47-55 with playground/review/windows)

| Workflow / job | Runner | Run (med/max) | Queue (med/max) | Notes |
|---|---|---|---|---|
| ci / lint, typecheck, unit | ubuntu | 1.9 / 2.3 | 8.7 / 28.6 | |
| ci / mutation scope | ubuntu | 0.2 | 4.8 / 22.9 | root of all gate jobs; fetch-depth 2 |
| ci / mutation (src) shard x4 + score | ubuntu | 24.5 / 35.7 (score 0.9) | 5.5 / 30 | critical path |
| ci / mutation (scripts) shard x3 + score | ubuntu | 2.3 / 19.1 | 6.1 / 35 | unbalanced |
| ci / mutation (plugin) shard x10 + score | ubuntu | 8.0 / 21.5 | 7.7 / 39 | |
| ci / mutation (aggregator) | ubuntu | 0.1 | 0.1 | the one stable check name |
| ci / expo prebuild | ubuntu | 0.8 | 2.6 / 47 | |
| ci / rn compat x7 | ubuntu | 0.4 each | 6-19 / 48 | 20-40 s of work each |
| ci / pack install x9 (7 + 2 android legs) | ubuntu | 0.8-1.4; android legs 2.8-3.2 | 5-14 / 49 | |
| ci / pack install ios x2 | macos-15 | 2.0 / 2.9 | 10-20 / 44 | |
| ci / android | ubuntu | 9.2 / 12.1 | 9.6 / 38 | |
| ci / ios unit | macos-15 | 3.6 / 4.4 | 10 / 40 | |
| ci / ios e2e | macos-15 | 11.8 / 15.8 | 10 / 47 | |
| ci / ios (cocoapods), ios (spm) | macos-15 | 5.7 / 4.1 | 17 / 13 (max 47) | |
| playground / js, android, ios | ubuntu, ubuntu, macos-26 | 1.2, 10.6, 12.5 | 0.3-2.5 | path-filtered, but `packages/**` matches nearly every PR |
| Claude PR Review / review | ubuntu (public repo) | 1.0 | 0.5 | skips drafts; `labeled` event only runs for `deep-review` |
| campaign windows hermes x2 | windows-latest | (see run) | | path-filtered to plugin/scripts/example android; temporary |
| bugseeai | - | - | - | issue/comment events only, not a PR check |

Critical path (run time, no queue): `mutation scope (0.2)` -> `mutation (src) shard (22-36)` ->
`score (0.9)` -> `mutation aggregator` = **~24-37 min** when src is touched; ~20 min when only
scripts/plugin gates run (scripts shard 3 at 19 min, or the plugin's slowest shard at 17-21). `ios e2e`
(12-16 + `needs` nothing) is the next chain, then `android` (9-12). The `needs:` graph is shallow;
the only dependency chains are scope -> gate shards -> score -> aggregator.

### Required checks
- `GET /rulesets` shows one ruleset ("Main", active, default branch): rules are only `deletion`,
  `non_fast_forward`, `required_linear_history`. **No `required_status_checks` rule.**
- `GET branches/main/protection` is 404 (not protected).
- So no job name is currently a required check; the "before it can merge" gating is by convention
  (or a check not visible to this token). The `mutation` aggregator comment says it is "the one
  stable check name for branch protection": that is kept untouched. Renames done here
  (rn compat, pack install) are therefore safe today, but would break required checks if a
  maintainer has configured them outside what the API shows (see section 5).

## 2. Findings (duplicate work, missing caches, over-scheduling)

1. No caching anywhere: yarn (15 installs), Gradle (`~/.gradle`, 7 min of the android job, playground android 10 min), CocoaPods (4-5.5 min in `ios e2e`, ~1.8 min in `ios (cocoapods)`), SPM, DerivedData. NDK/SDK come from the runner image (no downloads seen in these runs).
2. 14 tiny jobs per run (`rn compat` x7 at 20-40 s of work, 5 typecheck-only `pack install` legs under a minute) each pay runner start-up and, under contention, a queue wait: pure overhead in checks and in wall-clock.
3. Every PR runs every native build regardless of what changed (path filters exist only on `playground`, `campaign-windows` and the mutation scope). In the last 40 PRs only 4 (docs-only) would be fully skippable, but many touch one platform only (e.g. #158 android-heavy; #153 iOS + index.ts), so per-platform skipping removes the other platform's 6-8 macOS/Linux jobs.
4. `mutation (src)` is 4 shards of unequal cost and is the critical path; `scripts` has one dominant shard.
5. Concurrency with `cancel-in-progress` already exists on `ci`, `playground`, `campaign-windows`, and in the reusable review (good: cancelled runs in the data are superseded pushes).
6. Review workflow: caller subscribes to `labeled`; the reusable job's `if` filters all but `deep-review`, so other label events create a skipped run (a check shown as skipped, no cost). Harmless; not changed.
7. Flakiness: no NDK/SDK download failure and no `yarn install --immutable` exit-42 occurred in the 13 runs sampled (all conclusions success or cancelled-by-supersede). Exit 42 is Yarn's "lockfile would change" (a real error, not a network flake), so retrying it would hide a real mistake. Network flake candidates are the `pod install` CDN fetches and Gradle downloads, which the new caches also shield. No retries added.

## 3. Ranked proposals

| # | Proposal | Saves (critical path / checks / runner-min) | Risk | Status |
|---|---|---|---|---|
| 1 | Per-platform change gating (`scripts/ci-changes.sh`, fail-safe, self-tested): skip iOS builds on Android/JS-only diffs, Android on iOS/JS-only, everything native+app jobs on docs-only | 0 for cross-platform PRs; for single-platform PRs removes 6 macOS jobs (~22 macOS-min, a dozen-minute queue exposure) or 3 Linux (~15 min) | A change that affects a platform through an unlisted path: unknown paths count as both platforms, spec files (`Native*.ts`), scripts, workflows, yarn.lock, native-versions.json, plugin all run everything. Main and manual runs always run everything | Implemented |
| 2 | Fold `rn compat` 7->1 and `pack install` typecheck-only 5->1 jobs (same scripts, same versions, 3-4 in parallel inside the job) | -10 checks; ~-10 runner start-ups; removes 12 queue waits from the tail (median 7 min, max 49) | Names change (see section 5). One failure now reports in one job, with each version's log in its own group | Implemented |
| 3 | Cache `yarn` (setup-node `cache: yarn`), CocoaPods download dir, Gradle home (`setup-gradle`, read-only off main) | est. 15-40 s per yarn job x 15; 1.5-3 min off `ios e2e`; 1-4 min off `android`; playground android likely 2+ min. Cache is only filled by runs on main, so **the draft PR itself will not show the gain**; first measurable after merge | Content-addressed caches, so a stale hit cannot change what is built; PR runs are read-only for Gradle. A cache-service outage degrades to today's speed | Implemented |
| 4 | `mutation (src)` 4 -> 6 shards | slowest src shard 22-36 -> est. 15-24 min (critical path -7 to -12) at +2 checks and +2 installs (~+1.5 runner-min each) | None to coverage: same mutants, same break threshold, merge step re-checks the mutant count against the plan | Implemented, measured in the PR run |
| 5 | Rebalance `mutation (scripts)` (shard 3 is 5-10x shards 1, 2) by cost, not mutant count | critical path -8 to -10 min when only scripts changes (it is 19 min today) | Planner change in scripts/mutation-shards.ts, itself mutation-gated | Deferred (needs per-file cost data) |
| 6 | Stryker `--incremental` with a cached report from main, mutating only changed files on PRs | Large (src 25 -> a few min on small diffs) | Incremental reuses prior results for unchanged mutants: changes `how` not `what` but needs a safe cache key (tests + source hashes) and full runs on main/nightly. Do NOT lower thresholds | Deferred (design + trial) |
| 7 | `playground` ios/android: gate by the same classifier instead of `packages/**` | playground ios (macos-26, 12.5 min) on iOS-free PRs | Same as 1 | Deferred (needs its own scope job, +1 check) |
| 8 | Prime Metro's transform cache while xcodebuild compiles in `ios e2e` (already noted in the workflow) | 40-85 s of the warm-up | Low | Deferred |
| 9 | Nightly `schedule` running the full matrix on main (all RN minors with Android/iOS legs) | n/a, a safety net for 1 | none | Follow-up (not needed while main runs everything on every push) |
| 10 | Runner pool: larger runners / more macOS concurrency or self-hosted macOS for this public repo | The dominant fix for the 30-60 min wall-clock; queue is 50-70% of it | Admin decision, cost, and untrusted-PR code on self-hosted machines | Admin action |

## 4. Implemented in this PR (one concern per commit)

1. `cache: yarn` in setup-node for every job that runs `yarn install` (ci, mutation-gate, playground). Not in release.yml (untouched) or the temporary windows campaign.
2. Change classification (`scripts/ci-changes.sh`, run by the mutation scope job, which now also emits `app`, `android`, `ios`) + gating; consolidated rn compat and pack-install minors via `scripts/ci-each-version.sh`.
3. CocoaPods cache on `ios e2e` and `ios (cocoapods)`; `setup-gradle` on `android` and `playground android`.
4. `mutation (src)` shards 4 -> 6.

Job names that stay: lint, typecheck, unit; mutation scope; mutation (src|scripts|plugin) / shard N of M and score; mutation; expo prebuild (config plugin); pack install (0.81, android), (0.87, android), (0.81|0.87, ios); android; ios unit; ios e2e; ios (cocoapods|spm). Names that go: `rn compat (0.81..0.87)` -> `rn compat`; `pack install (0.82..0.86)` -> `pack install (0.82-0.86)`; the two Android legs are named `pack install (0.81)` / `(0.87)` (no `, android` suffix) when the diff cannot reach Android. `mutation (src) / shard N of 6` for N=5,6 are new.

### Not changed, and why
- Mutation thresholds (src 95, scripts 85, plugin per config), the aggregator, `fail-fast: false`, the dead-endpoint env, release.yml, secrets handling, the review workflow (runs in the org reusable workflow; its draft/label filters already avoid duplicate runs).
- No version trimming of the RN matrix: the compat/pack-install matrix is the guarantee that each supported minor typechecks and codegens; it is now cheap to keep whole (4 parallel runs in one job). Trimming to min/max would only save ~2 runner-minutes.
- No retries: no flake was observed in the sample; exit 42 is not one.

## 5. Needs a maintainer / admin

- Confirm no required-status-check list exists outside the ruleset API view (org-level rulesets, or the repo's classic protection configured with a token this research could not see). If `rn compat (0.8x)` or `pack install (0.8x)` names are required there, update them to `rn compat` and `pack install (0.82-0.86)`, or add them to a required set after merge. Prefer requiring only `mutation`, `lint, typecheck, unit` and an aggregator: skipped (path-gated) jobs report as skipped, which GitHub treats as passing for required checks, but a PR where a required job is skipped by an `if` still merges.
- Runner capacity (proposal 10): queue is the largest component of wall-clock. Options: larger hosted runners for macOS, a macOS self-hosted pool, or paying for more concurrency.
- Decide on a nightly/full run on main (proposal 9) and on the Stryker incremental design (6).
- Gradle/CocoaPods/yarn caches fill on main only; the first main push after merging populates them.

## 6. Measured result of the draft PR

(Filled in after the PR's own CI finished; see the PR description.)
