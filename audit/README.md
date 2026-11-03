# Site audit

A read-only audit of the whole site by a tree of Claude Code agents. It writes a ranked
report and changes no site code. Fixing is a separate step, after you triage the report.

## What runs

```
/audit (root)
├── audit-scout          maps the repo: live vs dead files, database paths, generated files
├── audit-area-lead x9   one per area in .claude/skills/audit/areas.json, all four categories
│   └── audit-specialist up to 3 per lead, one narrow question each
│       └── audit-specialist   may split its question: 2, then 1, then 1 child per layer
└── audit-verifier       tries to disprove each finding: confirmed / rejected / needs-human
```

Depth is capped at 5 layers in `.claude/settings.json`; Claude Code removes the spawn tool at
layer 5. The total budget (25 discovery agents, 15 verifiers) caps cost no matter how deep the
tree goes. Low-severity findings skip verification and are listed as leads. Budgets are in
`.claude/skills/audit/SKILL.md`; the report shows how many agents ran at each layer.

The root doesn't read agents' output itself. `merge.js` builds the coverage grid, the finding
index, the verifier groups and the report; the root only decides merges and fix batches.

## Files

| File | What it is | Who edits it |
|---|---|---|
| `.claude/skills/audit/SKILL.md` | The `/audit` command: steps, budgets | Rarely |
| `.claude/agents/audit-*.md` | The four agent types | Rarely |
| `.claude/skills/audit/areas.json` | Areas, their files, what to look for | When files are added, moved or removed |
| `.claude/skills/audit/known-context.md` | Facts that look like bugs but aren't | When how the site works changes |
| `.claude/skills/audit/decisions.md` | Findings you've ruled won't-fix / false positive | You, after each triage |
| `.claude/skills/audit/finding-schema.md` | Finding format and severity scale | Rarely |
| `.claude/skills/audit/merge.js` | Bookkeeping script: coverage, merges, verifier groups, report | When the report format changes |
| `audit/runs/<run-id>/` | One folder per run; `report.md` is the result | Nobody. Not committed. |

## Keep reports out of git

The repo is public. A report is a list of weaknesses, so `audit/runs/` is gitignored. Never
commit a report or paste one anywhere public.

## Running it

It runs in this folder, your normal working copy. Three things make that safe:

- **Credentials:** this folder has real Toast credentials in `.env`. Agents are told never to
  read `.env` or run the scripts that call Toast or write to the live database, and
  `.claude/settings.json` denies those commands and reads outright.
- **Your uncommitted work:** the audit reads the files as they are, including uncommitted
  edits, and lists those files in the report. It never reverts, restores or stashes anything.
- **Change check:** at the start it hashes every file; at the end it hashes again and lists
  anything that changed during the run. It doesn't undo those changes; you check them.

Avoid editing site files while it runs, so anything in that list is clearly an agent's doing.

1. **Terminal (PowerShell):** check Claude Code is recent enough for nested agents:
   `claude --version` (needs 2.1.219 or later; update with `claude update`)
2. **Terminal (PowerShell):** go to this folder and start Claude Code:
   ```
   cd "$env:USERPROFILE\OneDrive\Career\Half Shell\Oyster Management\Oyster Website"
   claude
   ```
3. **Claude Code:** type `/audit` for everything, or `/audit passport server` for chosen areas.
4. **Claude Code:** approve the prompts it shows. Writes inside `audit/runs/`, the repo's
   tests and `merge.js` are pre-approved; anything else asks. If an agent asks to edit a site
   file, read `.env`, or run a Toast or sync script, decline.
5. **File Explorer or any editor:** open `audit\runs\<run-id>\report.md`.

OneDrive syncs the run folder while the audit writes to it. If you see "file in use" or
write errors, pause OneDrive syncing (tray icon > Pause syncing > 2 hours) and run again.

Java 21+ is needed only for the database rules test (`tools/rules-test`). Without it the
report lists that check as "not run". It doesn't fail the audit.

## After a run

1. Read `report.md`. Check the **Needs a human check** items yourself (Firebase console,
   GitHub settings).
2. For rejected findings you agree with, and confirmed ones you won't fix, add a line to
   `decisions.md` so later audits skip them.
3. Pick the fix batches you want. Fixing is a separate step: one fixer per batch, on a
   branch, each writing its own full-diff entry straight to `Changelog.md` in the house
   format. That step isn't built yet. The audit itself never writes to the changelog,
   because it changes no site code.
4. After fixes, re-audit only the areas they touched: `/audit <area> <area>`.

## Cost

Modelled, not measured. The reviewable code is about 240k tokens, but every agent turn
resends that agent's whole context, so total input is far larger than the code size:

| | Low | High |
|---|---|---|
| Total input (mostly cache reads) | ~11M | ~37M |
| Fresh, uncached input | ~0.9M | ~2M |
| Output | ~130k | ~300k |

Low = 8 specialists, 8 verifiers, small contexts. High = the full budget (15 specialists,
15 verifiers). Leads are now the largest share: reading every file in full is the floor for
a full audit. Calibrate with
`/audit dev-tools` (the smallest area) before a full run.
