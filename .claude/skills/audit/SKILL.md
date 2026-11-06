---
description: Read-only audit of the Half Shell site by a tree of agents (scout, area leads, specialists, verifiers). Full audit by default, or a goal such as security. Writes a ranked report; changes no site code.
argument-hint: "[goal] [area ...] [focus: text]   e.g.  security   |   security passport server   |   focus: phone sign-in"
disable-model-invocation: true
allowed-tools: Bash(git status *) Bash(git rev-parse *) Bash(git log *) Bash(git show *) Bash(git diff *) Bash(git ls-files *) Bash(git grep *) Bash(node *) Bash(npm install*) Bash(npm test*) Bash(mkdir *) Bash(ls *) Read Grep Glob Write
---

# /audit — root of the audit tree

You are the root (layer 0). You run the audit, keep the run folder, and finish the report.
You do not review code yourself and you never edit site files.

Supporting files in this folder:

- `areas.json` — the seed areas, their files, risk and focus
- `known-context.md` — facts that look like bugs but aren't, and how the site deploys
- `finding-schema.md` — the one format every agent reports in, and the severity scale
- `decisions.md` — findings Garrett already ruled on; never re-raise these
- `goals.json` — what each goal (full, security) reviews, its checklist and verify rules
- `merge.js` — does the bookkeeping: run setup, write guard, output validation, change
  snapshot, coverage grid, finding index, merges, verifier groups, report

Read the first four before step 3. You don't need to read `merge.js`; run it.

The audit tool's own files (`.claude/`, `audit/`) are never audited.

Arguments: `$ARGUMENTS`, passed unchanged to `merge.js init` (step 1), which parses them:

- an optional **goal** first, from `goals.json` (`full` if omitted; `security` reviews only
  security, skips `conventions`, verifies low findings too, and gives every agent an
  attacker checklist);
- optional **areas** (only those, plus `seams` if two or more are named);
- optional **`focus:`** followed by free text, passed to every agent as a priority.

`init` writes the goal into `run.json` as `goal` (categories, brief, checklist) and the area
leads to spawn as `leads`. Every prompt you write below includes the goal block and focus.

## Hard rules

- **You never change a site file, at any step, for any reason.** A failing test or an
  obvious one-line fix is a finding with a `proposed_fix`, not something to do. The same
  goes for every agent you spawn.
- `.claude/hooks/audit-guard.js` enforces this while `audit/runs/.active` exists: it blocks
  writes outside the run folder, git commands that change anything, `firebase` and `sed -i`.
  If it blocks you, don't look for another way round; record a finding.
- Only say "no site code was changed" if `merge.js report` printed no WARNING about changes
  outside the run folder.

## Keep your own context small

You are the most expensive agent per turn, because your context grows the whole run.

- Never Read `agents/*.json`, `verdicts/*.json`, `findings-all.json` or `findings-merged.json`.
  `merge.js` reads them and prints what you need.
- Leads and verifiers return 10 and 5 lines. Don't ask them for more.
- The files you do read: `map.json` summary fields (step 4), `findings-index.md` (step 6),
  and the fix-batch section of `report.md` (step 9).

## The tree

```
layer 0  root (you)
layer 1  audit-scout ─ then ─ audit-area-lead x N        audit-verifier x M (step 7)
layer 2                       audit-specialist (max 3 per lead)
layer 3                       audit-specialist (max 2 per parent)
layer 4                       audit-specialist (max 1 per parent)
layer 5                       audit-specialist (max 1 per parent; cannot spawn)
```

`.claude/settings.json` sets `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=5`, so Claude Code removes
the Agent tool at layer 5. Verifiers are spawned by you, not by leads, so the agent that checks
a finding never saw the reasoning that produced it. Sweeps (step 5) are layer 1 and don't spawn.

## Budgets

| Budget | Limit |
|---|---|
| Discovery agents (scout + leads + specialists at every layer + sweeps) | 25 |
| Children per agent | lead 3 · layer 2: 2 · layer 3: 1 · layer 4: 1 · layer 5: 0 |
| Verifier agents | 15, each checking up to 6 findings in the same file |
| Low-severity findings | not verified; listed in the report as leads |
| Agents running at once | 30 (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`) |

Discovery agents are counted as files in `requests/`. The per-agent limits allow one lead up
to 3 + 6 + 6 + 6 = 21 descendants, more than the 15 specialist slots left after the scout and
9 leads, so the 25 total is the limit that binds. If it runs out, stop spawning, finish with
what you have, and the report lists what went unreviewed.

## Steps

### 0. Where you are running

The audit runs in Garrett's own working copy (inside OneDrive), not a clone. That copy has
real Toast credentials in `.env` and may hold uncommitted work. Read the "Running code during
the audit" section of `known-context.md` now; it applies to you and every agent.
`.claude/settings.json` denies the dangerous commands, but the rules there are the backstop,
not the plan.

1. `git rev-parse --show-toplevel` must succeed and be the current directory. If not, stop.
2. Record `git status --porcelain` (ignore `audit/runs/`). Uncommitted files don't stop the
   audit; they are audited as they are and listed in the report.
3. Never revert, restore, stash or clean anything, at any step.

### 1. Run folder

Run id = local time `YYYY-MM-DD-HHMM`. Run:

```
node .claude/skills/audit/merge.js audit/runs/<run-id> init $ARGUMENTS
```

It creates the folder (`requests/`, `agents/`, `verdicts/`, `scratch/`), writes `run.json`
(commit, uncommitted files, budgets, goal, areas, leads, focus), turns the write guard on and
takes the start snapshot. If it prints an ERROR (unknown goal or area), stop and show it to
Garrett. Don't write `run.json` by hand.

Every agent writes only its own file. No agent edits another agent's file, so parallel
agents never overwrite each other.

### 2. Automated checks (no AI judgement)

Run each from the repo root:

- `npm install` in `cloud/`, then `node cloud/test.js`
- `node tools/<name>-test.js` for every `tools/*-test.js`
  (`flights-test.js` reads the live public menu over the internet — read-only; if offline,
  record "not run: offline", not a failure)
- Parse check: load each `data/*.js` with `node -e` inside one `vm` context, `data/regions.js`
  first (`data/flights.js` needs it); any throw is a failure
- `tools/rules-test`: needs Java 21+. Run `npm install` then `npm test` in that folder; `npm test`
  starts the database emulator against the demo project "demo-hs-rules", never the live
  database. Running `node rules-test.js` directly fails because no emulator is running. If Java
  is missing, record "not run: no Java" and move on. If the emulator can't start because a
  port (9000, 4400, 4500) is in use, record "not run: port <n> in use" — never retry by
  killing processes, and never treat it as a pass.

A security goal runs every check too: a broken test can hide a security regression.

Write `checks.json`: `[{"check": "", "result": "pass|fail|not run", "detail": "last lines or reason"}]`.
For each failure, also write a finding (id `CHK-NN`, category from what broke) into
`agents/checks.json` as `{"id": "checks", "role": "checks", "coverage": [], "findings": [...]}`,
then run `merge.js <run folder> validate agents/checks.json` and fix it until it prints OK.
A check that could not run is never counted as a pass. **Don't fix what failed** — not even
when the fix is one line and you're sure of it. Write the fix in `proposed_fix`.

### 3. Scout

Write `requests/scout.json` (`{"id": "scout", "layer": 1}`), then spawn `audit-scout` with the
run folder path and wait for it.

### 4. Area leads

Run `merge.js <run folder> validate agents/scout.json`; if it fails, give the scout's
problems to a new `audit-scout` with "fix only your files" and validate again (one retry).
Read only these fields of `map.json`: `area_changes`, `unassigned`, `area_sizes`. Apply the
changes to the areas. Then for each area in `run.json` `leads` (which already leaves out any
area the goal skips) write
`requests/L-<area>.json` (`{"id": "L-<area>", "layer": 1, "area": "<area>"}`) and spawn one
`audit-area-lead`, all in parallel. Each prompt contains exactly:

- the run folder path
- the area id and its entry from `areas.json` (with the scout's changes applied)
- the agent id `L-<area>`
- the discovery budget from `run.json`
- the goal: its `name`, `categories`, `brief`, the `checklist` items that apply to this area,
  and `focus` if set — copied from `run.json`

Wait for every lead to finish. Then go to "Validate outputs" below.

### Validate outputs (after step 4, after sweeps in step 5, after step 7)

Run `merge.js <run folder> validate`. Every agent already ran it on its own file, so this
should print OK. For each file it lists, spawn one fresh agent of the same type with: the run
folder, the file path, the PROBLEM lines, and "Fix only the format of this file so validate
passes. Don't re-review code, don't add or drop findings." Validate again. After one retry,
leave it: the report lists remaining problems under "Agent output problems".

### 5. Coverage

Run `node .claude/skills/audit/merge.js <run folder> coverage`. It writes `coverage.json` and
`coverage.md`, and prints the coverage % and the unreviewed cells by area.

Coverage counts only the goal's categories. For unreviewed cells, spawn sweep agents
(`audit-specialist`, id `SW-NN`, request `{"id": "SW-NN", "parent": "root", "layer": 1,
"question": "Review these files for <categories>", "files": [...], "categories": [...],
"goal": <run.json goal>, "focus": "", "stop_when": "every listed file is reviewed"}`), one per
area's group of files, while budget lasts. Validate, then run `coverage` again.

### 6. Merge

Run `merge.js <run folder> findings`. Read `findings-index.md`: one line per finding plus
candidate duplicate groups. Decide:

- **Merges:** same root cause, even across files or agents. A candidate group is only a hint;
  findings that share a line but have different causes stay separate.
- **Drops:** anything matching `decisions.md` or `known-context.md`.

Write `merges.json`:
`{"merge": [{"keep": "<id>", "absorb": ["<id>"], "severity": "<optional override>"}],
  "drop": [{"id": "<id>", "reason": ""}]}`.
Then run `merge.js <run folder> apply`. Fix anything it prints as a PROBLEM and run it again.

### 7. Verify

`verify-groups.json` lists the verifier groups (by file, most severe first, within budget).
For each group, spawn `audit-verifier` with the run folder, the group id, the finding ids and
the goal name. Run up to 10 at a time. Verifiers get no request file; `verify-groups.json` is
the record. Findings outside the goal's categories are not verified; the report lists them
separately. Then validate (verdicts must include `severity` for every finding).

### 8. What changed during the run

Run `merge.js <run folder> snapshot end`. It compares every file against the step 1 snapshot
and writes `outside.txt` if anything outside the run folder changed. Do not revert anything:
a change could be an agent's mistake, or Garrett editing files while the audit ran, and you
can't tell which. The report lists them for him to check.

### 9. Report

Run `merge.js <run folder> validate`, then `merge.js <run folder> report`. It writes
`report.md` with every section filled except **Proposed fix batches**, which holds candidate
batches grouped only by shared files. Read that section, regroup by root cause, name each
batch, and replace the `ROOT:` comment. Don't touch the rest of the report.

### 10. Finish

Run `merge.js <run folder> finish`. It turns the write guard off. Always run it, even if the
audit stopped early.

Then tell Garrett in chat: the goal, the line `merge.js report` printed, the path of the
report, any PROBLEM or WARNING lines, and either "no site code was changed" or the list of
files changed outside the run folder. Nothing is fixed in this command.
