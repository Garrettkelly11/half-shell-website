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

Run it from a fresh clone **outside OneDrive**. A clone has no `.env`, so no agent can reach
Toast or write to the live database, and OneDrive has served truncated files to tools before.
The audit refuses to start if the working tree has uncommitted changes, so commit these audit
files to `main` first.

1. **Terminal (PowerShell):** check Claude Code is recent enough for nested agents:
   `claude --version` (needs 2.1.219 or later; update with `claude update`)
2. **Terminal (PowerShell):** make a clone in a folder OneDrive doesn't sync, for example:
   ```
   mkdir C:\dev -Force; cd C:\dev
   git clone https://github.com/Garrettkelly11/half-shell-website.git hs-audit
   cd hs-audit
   ```
   (Already have one? `cd C:\dev\hs-audit; git pull` instead.)
3. **Terminal (PowerShell), same folder:** start Claude Code with `claude`
4. **Claude Code:** type `/audit` for everything, or `/audit passport server` for chosen areas.
5. **Claude Code:** approve the prompts it shows. Writes inside `audit/runs/` and `node`
   commands are pre-approved; anything else asks. If an agent asks to edit a site file,
   decline. The audit never needs to.
6. **File Explorer or any editor:** open `audit\runs\<run-id>\report.md`.

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
