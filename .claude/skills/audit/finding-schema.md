# Finding format and severity scale

Every agent reports findings in this exact shape. A finding without a concrete failure
scenario and quoted evidence is not a finding; leave it out.

```json
{
  "id": "<agent id>-F<NN>",
  "area": "passport",
  "category": "functionality | security | optimization | format",
  "severity": "critical | high | medium | low",
  "title": "One line, under 80 characters, stating the defect",
  "files": [{"path": "src/passport-store.js", "lines": "120-134"}],
  "failure_scenario": "Concrete: who does what, with what input, and what goes wrong. 'A signed-in customer calls X with Y and Z happens.' Not 'could be a problem'.",
  "evidence": "The relevant lines, quoted, with line numbers",
  "proposed_fix": "What to change, in a sentence or two. Name files. No full patches.",
  "fix_touches": ["every file the fix would change, across areas"],
  "confidence": "high | medium | low",
  "found_by": "S-passport-02"
}
```

IDs: `<agent id>-F<NN>`, e.g. `L-passport-F01`, `S-passport-02-01-F03`, `SW-04-F01`.
Automated checks use `CHK-NN`.

## Severity, for this site

| Severity | Means | Examples |
|---|---|---|
| critical | Customer data exposed, anyone can change the menu or prices, a secret leaks, or the menu is down for everyone | Unauthenticated write to `/menu/serving`; one customer can read another's phone number; a token in a committed file |
| high | Customers see wrong information, a staff action silently fails, sign-in breaks for a group, the privacy page doesn't match what the code does, a compliance requirement is missing | Wrong price shown during happy hour; delete-my-account leaves data behind; consumer advisory missing |
| medium | Breaks in a plausible situation, a noticeably slow page, or a trap that is likely to cause a future bug | Menu goes blank when Toast is down; two copies of the price logic that can drift apart |
| low | Style, naming, minor performance, dead code with no risk | Inconsistent naming; unused helper; stale comment |

Category tie-break: if a defect is both, pick the category of its worst consequence (an XSS
bug is security, even though it starts as a formatting choice).

## What not to report

- Anything in `decisions.md` or covered by `known-context.md`
- Preferences with no consequence ("I'd use a different framework")
- Micro-optimizations with no visible effect on a phone
- The same root cause more than once: report it once and list every location in `files`
