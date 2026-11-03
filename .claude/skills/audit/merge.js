#!/usr/bin/env node
/**
 * merge.js — bookkeeping for /audit, so the root agent never has to read every
 * agent's file into its own context.
 *
 * Terminal, from the repo root:
 *   node .claude/skills/audit/merge.js <run folder> snapshot start
 *   node .claude/skills/audit/merge.js <run folder> snapshot end
 *   node .claude/skills/audit/merge.js <run folder> coverage
 *   node .claude/skills/audit/merge.js <run folder> findings
 *   node .claude/skills/audit/merge.js <run folder> apply
 *   node .claude/skills/audit/merge.js <run folder> report
 *
 * snapshot  start: hashes every file git tracks or would track (plus .env files), so the
 *           audit can run in a working copy with uncommitted work. end: hashes again and
 *           writes outside.txt listing anything an agent changed, added or deleted.
 *           It never restores or reverts anything.
 * coverage  map.json + agents/*.json  -> coverage.json, coverage.md
 *           Prints the coverage % and the unreviewed cells grouped by area (for sweeps).
 * findings  agents/*.json              -> findings-all.json, findings-index.md
 *           The index is one short line per finding plus candidate duplicate groups.
 *           The root reads only the index, then writes merges.json (format below).
 * apply     findings-all.json + merges.json -> findings-merged.json, verify-groups.json, verify/V-NN.json
 *           Groups findings for verifiers by file, highest severity first, within budget.
 *           Low findings and CHK- findings are not sent to verifiers.
 * report    everything above + verdicts/*.json + checks.json -> report.md
 *           Leaves one section for the root to finish: fix batches.
 *
 * merges.json, written by the root after reading findings-index.md:
 *   {"merge": [{"keep": "<id>", "absorb": ["<id>", ...], "severity": "high"}],   severity optional
 *    "drop":  [{"id": "<id>", "reason": "matches decisions.md: ..."}]}
 *
 * checks.json, written by the root in step 2:
 *   [{"check": "node cloud/test.js", "result": "pass|fail|not run", "detail": "last lines or reason"}]
 *
 * No dependencies. Node 18+.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CATEGORIES = ['functionality', 'security', 'optimization', 'format'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const CAT_RANK = { security: 0, functionality: 1, optimization: 2, format: 3 };
const RESULT_RANK = { findings: 0, cleared: 1, 'n/a': 2, unreviewed: 3 };

const [, , runDir, command] = process.argv;
if (!runDir || !command) {
  console.error('Usage: node merge.js <run folder> coverage|findings|apply|report');
  process.exit(2);
}

// ---------- helpers ----------

function readJson(file, fallback) {
  const p = path.join(runDir, file);
  if (!fs.existsSync(p)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing ${p}`);
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`Bad JSON in ${p}: ${e.message}`);
  }
}

function writeOut(file, data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(path.join(runDir, file), text);
}

function readDir(dir) {
  const p = path.join(runDir, dir);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const name of fs.readdirSync(p).filter((n) => n.endsWith('.json')).sort()) {
    try {
      out.push({ name, data: JSON.parse(fs.readFileSync(path.join(p, name), 'utf8')) });
    } catch (e) {
      // A broken agent file is reported, not fatal: the rest of the run is still usable.
      console.error(`WARNING: skipping ${dir}/${name}: ${e.message}`);
    }
  }
  return out;
}

function agents() {
  return readDir('agents').map((a) => a.data);
}

function parseLines(spec) {
  // "120-134" -> [120, 134]; "88" -> [88, 88]; anything else -> null
  const m = String(spec || '').match(/(\d+)\s*(?:-\s*(\d+))?/);
  if (!m) return null;
  const a = Number(m[1]);
  return [a, m[2] ? Number(m[2]) : a];
}

function overlaps(a, b, slack = 5) {
  return a && b && a[0] <= b[1] + slack && b[0] <= a[1] + slack;
}

function words(s) {
  return new Set(String(s || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function primaryFile(f) {
  return (f.files && f.files[0] && f.files[0].path) || '(no file)';
}

function where(f) {
  return (f.files || []).map((x) => (x.lines ? `${x.path}:${x.lines}` : x.path)).join(', ');
}

function bySeverity(a, b) {
  return (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9)
    || (CAT_RANK[a.category] ?? 9) - (CAT_RANK[b.category] ?? 9)
    || String(a.id).localeCompare(String(b.id));
}

function unionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => { parent[find(a)] = find(b); };
  const groups = () => {
    const g = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!g.has(r)) g.set(r, []);
      g.get(r).push(i);
    }
    return [...g.values()];
  };
  return { join, groups };
}

function cell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

// ---------- snapshot ----------

function hashTree() {
  const { execFileSync } = require('child_process');
  const crypto = require('crypto');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  // Tracked files plus untracked files that aren't ignored: covers uncommitted work but
  // skips node_modules, lockfiles and audit/runs, which are gitignored.
  const listed = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  for (const extra of ['.env', 'functions/.env']) {
    if (fs.existsSync(path.join(root, extra))) listed.push(extra);
  }
  const files = {};
  for (const rel of [...new Set(listed)].sort()) {
    if (rel.startsWith('audit/runs/')) continue;
    const abs = path.join(root, rel);
    try {
      files[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    } catch (e) {
      // Tracked but deleted from disk: leave it out, so a deletion shows as "deleted".
      if (e.code !== 'ENOENT') files[rel] = `unreadable: ${e.code}`;
    }
  }
  return files;
}

function snapshot() {
  const phase = process.argv[4];
  if (phase === 'start') {
    const files = hashTree();
    writeOut('snapshot-start.json', { time: new Date().toISOString(), files });
    console.log(`Snapshot taken: ${Object.keys(files).length} files.`);
    return;
  }
  if (phase !== 'end') throw new Error('Use: snapshot start | snapshot end');
  const before = readJson('snapshot-start.json').files;
  const after = hashTree();
  writeOut('snapshot-end.json', { time: new Date().toISOString(), files: after });
  const lines = [];
  for (const [f, h] of Object.entries(after)) {
    if (!(f in before)) lines.push(`added:   ${f}`);
    else if (before[f] !== h) lines.push(`changed: ${f}`);
  }
  for (const f of Object.keys(before)) if (!(f in after)) lines.push(`deleted: ${f}`);
  const outside = path.join(runDir, 'outside.txt');
  if (lines.length) {
    fs.writeFileSync(outside, lines.join('\n') + '\n');
    console.log(`${lines.length} files changed outside the run folder during the audit. Nothing was reverted.`);
    for (const l of lines) console.log(l);
  } else {
    if (fs.existsSync(outside)) fs.unlinkSync(outside);
    console.log('No files changed outside the run folder.');
  }
}

// ---------- coverage ----------

function coverage() {
  const map = readJson('map.json');
  const files = map.files || [];
  const grid = {};
  for (const f of files) {
    grid[f.path] = {};
    for (const c of CATEGORIES) {
      // Generated and dead files default to n/a; agents can still override with a real result.
      const def = f.status === 'generated' ? { result: 'n/a', note: 'generated', by: 'scout' }
        : f.status === 'dead' ? { result: 'n/a', note: 'dead file', by: 'scout' }
        : { result: 'unreviewed', note: '', by: '' };
      grid[f.path][c] = def;
    }
  }

  const unknown = new Set();
  for (const a of agents()) {
    for (const e of a.coverage || []) {
      if (!grid[e.file]) { unknown.add(e.file); continue; }
      if (!CATEGORIES.includes(e.category)) continue;
      const cur = grid[e.file][e.category];
      const curRank = cur.by === 'scout' ? 2.5 : RESULT_RANK[cur.result]; // agent results beat scout defaults
      if ((RESULT_RANK[e.result] ?? 9) <= curRank) {
        grid[e.file][e.category] = { result: e.result, note: e.note || '', by: a.id };
      }
    }
  }

  let total = 0, done = 0;
  const unreviewedByArea = {};
  const areaOf = Object.fromEntries(files.map((f) => [f.path, f.area || '(none)']));
  for (const [file, cats] of Object.entries(grid)) {
    for (const c of CATEGORIES) {
      total++;
      if (cats[c].result !== 'unreviewed') { done++; continue; }
      const area = areaOf[file];
      unreviewedByArea[area] = unreviewedByArea[area] || {};
      (unreviewedByArea[area][file] = unreviewedByArea[area][file] || []).push(c);
    }
  }
  const pct = total ? Math.round((done / total) * 1000) / 10 : 0;
  const unreviewed = Object.entries(unreviewedByArea).map(([area, fm]) => ({
    area,
    files: Object.keys(fm),
    categories: [...new Set(Object.values(fm).flat())],
  }));

  writeOut('coverage.json', { total, done, pct, unreviewed, unknown_files: [...unknown], grid });

  const short = { findings: 'F', cleared: 'ok', 'n/a': 'n/a', unreviewed: '—' };
  let md = `# Coverage\n\n${done} of ${total} cells (${pct}%). F = findings, ok = cleared, — = unreviewed.\n\n`;
  md += `| File | ${CATEGORIES.join(' | ')} |\n|---|${CATEGORIES.map(() => '---').join('|')}|\n`;
  for (const [file, cats] of Object.entries(grid)) {
    md += `| ${cell(file)} | ${CATEGORIES.map((c) => short[cats[c].result] || cats[c].result).join(' | ')} |\n`;
  }
  writeOut('coverage.md', md);

  console.log(`Coverage: ${done}/${total} cells (${pct}%).`);
  if (unknown.size) console.log(`Coverage entries for files not in map.json: ${[...unknown].join(', ')}`);
  if (!unreviewed.length) console.log('No unreviewed cells.');
  for (const u of unreviewed) {
    console.log(`Unreviewed in ${u.area}: ${u.files.length} files [${u.categories.join(', ')}]: ${u.files.join(', ')}`);
  }
}

// ---------- findings ----------

function findings() {
  const all = [];
  const seen = new Set();
  for (const a of agents()) {
    for (const f of a.findings || []) {
      if (!f.id) { console.error(`WARNING: finding without id from ${a.id}; skipped`); continue; }
      if (seen.has(f.id)) { console.error(`WARNING: duplicate id ${f.id}; second copy skipped`); continue; }
      seen.add(f.id);
      all.push({ ...f, found_by: f.found_by || a.id });
    }
  }
  all.sort(bySeverity);
  writeOut('findings-all.json', all);

  // Candidate duplicates: overlapping lines in the same file, or very similar titles in the same category.
  const uf = unionFind(all.length);
  const titleWords = all.map((f) => words(f.title));
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      const sameSpot = (a.files || []).some((x) => (b.files || []).some((y) =>
        x.path === y.path && overlaps(parseLines(x.lines), parseLines(y.lines))));
      const sameTitle = a.category === b.category && jaccard(titleWords[i], titleWords[j]) >= 0.5;
      if (sameSpot || sameTitle) uf.join(i, j);
    }
  }
  const candidates = uf.groups().filter((g) => g.length > 1);

  let md = `# Findings index\n\n${all.length} findings. One line each: id | severity | category | where | title.\n`;
  md += 'Decide merges and drops from this file, then write merges.json (format in merge.js).\n\n';
  for (const f of all) {
    md += `- ${f.id} | ${f.severity} | ${f.category} | ${where(f)} | ${f.title}\n`;
  }
  md += `\n## Candidate duplicate groups (${candidates.length})\n\n`;
  md += 'Same file with overlapping lines, or similar titles in one category. Candidates only: merge only if the root cause is the same.\n\n';
  candidates.forEach((g, n) => {
    md += `${n + 1}. ${g.map((i) => all[i].id).join(', ')}\n`;
  });
  writeOut('findings-index.md', md);

  const counts = SEVERITIES.map((s) => `${s} ${all.filter((f) => f.severity === s).length}`).join(', ');
  console.log(`${all.length} findings (${counts}); ${candidates.length} candidate duplicate groups. Read findings-index.md.`);
}

// ---------- apply ----------

function apply() {
  const all = readJson('findings-all.json');
  const merges = readJson('merges.json', { merge: [], drop: [] });
  const run = readJson('run.json', {});
  const budget = (run.budgets && run.budgets.verifiers) || 15;
  const groupSize = (run.budgets && run.budgets.group_size) || 6;
  const verifyLow = Boolean(run.budgets && run.budgets.verify_low);

  const byId = new Map(all.map((f) => [f.id, { ...f, found_by: [].concat(f.found_by), merged_from: [] }]));
  const gone = new Set();
  const problems = [];

  for (const m of merges.merge || []) {
    const keep = byId.get(m.keep);
    if (!keep) { problems.push(`merge: unknown keep id ${m.keep}`); continue; }
    for (const id of m.absorb || []) {
      const other = byId.get(id);
      if (!other || id === m.keep) { problems.push(`merge: unknown or self absorb id ${id}`); continue; }
      keep.found_by.push(...other.found_by);
      keep.merged_from.push(id);
      const paths = new Set((keep.files || []).map((x) => `${x.path}:${x.lines}`));
      for (const x of other.files || []) if (!paths.has(`${x.path}:${x.lines}`)) keep.files.push(x);
      keep.fix_touches = [...new Set([...(keep.fix_touches || []), ...(other.fix_touches || [])])];
      if ((SEV_RANK[other.severity] ?? 9) < (SEV_RANK[keep.severity] ?? 9)) keep.severity = other.severity;
      gone.add(id);
    }
    if (m.severity && SEVERITIES.includes(m.severity)) keep.severity = m.severity;
    keep.found_by = [...new Set(keep.found_by)];
  }
  const dropped = [];
  for (const d of merges.drop || []) {
    if (!byId.has(d.id)) { problems.push(`drop: unknown id ${d.id}`); continue; }
    gone.add(d.id);
    dropped.push({ id: d.id, title: byId.get(d.id).title, reason: d.reason || '' });
  }

  const merged = [...byId.values()].filter((f) => !gone.has(f.id)).sort(bySeverity);
  for (const f of merged) {
    if (String(f.id).startsWith('CHK-')) f.verify = 'checked';
    else if (f.severity === 'low' && !verifyLow) f.verify = 'skipped-low';
    else f.verify = 'pending';
  }

  // Verifier groups: by primary file, up to groupSize each, most severe groups first.
  const pending = merged.filter((f) => f.verify === 'pending');
  const byFile = new Map();
  for (const f of pending) {
    const k = primaryFile(f);
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k).push(f);
  }
  let groups = [];
  for (const [file, list] of byFile) {
    for (let i = 0; i < list.length; i += groupSize) {
      const chunk = list.slice(i, i + groupSize);
      groups.push({ file, findings: chunk.map((f) => f.id), worst: Math.min(...chunk.map((f) => SEV_RANK[f.severity] ?? 9)) });
    }
  }
  groups.sort((a, b) => a.worst - b.worst || b.findings.length - a.findings.length);
  const sent = groups.slice(0, budget).map((g, i) => ({ id: `V-${String(i + 1).padStart(2, '0')}`, file: g.file, findings: g.findings }));
  const over = new Set(groups.slice(budget).flatMap((g) => g.findings));
  for (const f of merged) if (over.has(f.id)) f.verify = 'skipped-budget';

  writeOut('findings-merged.json', { findings: merged, dropped, problems });
  writeOut('verify-groups.json', sent);
  // One small file per group, so each verifier reads only its own findings.
  fs.mkdirSync(path.join(runDir, 'verify'), { recursive: true });
  const mergedById = new Map(merged.map((f) => [f.id, f]));
  for (const g of sent) {
    writeOut(path.join('verify', `${g.id}.json`), { id: g.id, file: g.file, findings: g.findings.map((id) => mergedById.get(id)) });
  }

  console.log(`${merged.length} findings after merge (${gone.size - dropped.length} absorbed, ${dropped.length} dropped).`);
  console.log(`${sent.length} verifier groups (budget ${budget}, up to ${groupSize} findings each).`);
  const skippedLow = merged.filter((f) => f.verify === 'skipped-low').length;
  if (skippedLow) console.log(`${skippedLow} low findings not sent to verifiers.`);
  if (over.size) console.log(`${over.size} findings not verified: over budget.`);
  for (const p of problems) console.log(`PROBLEM: ${p}`);
}

// ---------- report ----------

function report() {
  const run = readJson('run.json', {});
  const { findings: merged, dropped } = readJson('findings-merged.json');
  const cov = readJson('coverage.json', { total: 0, done: 0, pct: 0, unreviewed: [] });
  const checks = readJson('checks.json', []);
  const requests = readDir('requests').map((r) => r.data);
  const verdicts = new Map();
  for (const v of readDir('verdicts')) {
    for (const x of v.data.verdicts || []) verdicts.set(x.finding, { ...x, group: v.data.id });
  }

  for (const f of merged) {
    const v = verdicts.get(f.id);
    if (f.verify === 'checked') f.status = 'confirmed';
    else if (v) {
      f.status = v.verdict;
      f.verifier = v;
      if (v.severity && SEVERITIES.includes(v.severity)) f.severity = v.severity;
    } else if (f.verify === 'pending') f.status = 'unverified';
    else f.status = f.verify; // skipped-low, skipped-budget
  }
  merged.sort(bySeverity);
  const is = (s) => merged.filter((f) => f.status === s);
  const confirmed = is('confirmed');

  const discovery = requests.filter((r) => !String(r.id).startsWith('V-')).length;
  const verifierCount = readDir('verdicts').length;
  const layers = [1, 2, 3, 4, 5].map((l) => `L${l} ${requests.filter((r) => (r.layer ?? (String(r.id).startsWith('S-') ? 2 : 1)) === l && !String(r.id).startsWith('V-')).length}`).join(' · ');
  const b = run.budgets || {};

  let md = `# Half Shell site audit — ${run.run_id || path.basename(runDir)}\n\n`;
  md += `Commit \`${run.commit || '?'}\` · Areas: ${(run.areas || ['all']).join(', ')} · No site code was changed by the audit.\n\n`;
  if (run.uncommitted && run.uncommitted.length) {
    md += `Audited the working copy as it was, including ${run.uncommitted.length} uncommitted or untracked files: ${run.uncommitted.map((u) => `\`${u}\``).join(', ')}.\n\n`;
  }

  md += '## Summary\n\nConfirmed findings (plus automated check failures):\n\n';
  md += `| | ${SEVERITIES.map((s) => s[0].toUpperCase() + s.slice(1)).join(' | ')} |\n|---|${SEVERITIES.map(() => '---').join('|')}|\n`;
  for (const c of ['security', 'functionality', 'optimization', 'format']) {
    md += `| ${c[0].toUpperCase() + c.slice(1)} | ${SEVERITIES.map((s) => confirmed.filter((f) => f.category === c && f.severity === s).length || '').join(' | ')} |\n`;
  }
  md += `\nAlso: ${is('needs-human').length} need a human check · ${is('skipped-low').length} low not verified · `;
  md += `${is('skipped-budget').length + is('unverified').length} not verified (budget or missing verdict) · ${is('rejected').length} rejected.\n\n`;
  md += `Coverage: ${cov.done} of ${cov.total} cells (${cov.pct}%).\n\n`;
  md += `Agents: ${discovery}/${b.discovery ?? '?'} discovery, ${verifierCount}/${b.verifiers ?? '?'} verifier. By layer: ${layers}.\n\n`;

  md += '## Automated checks\n\n| Check | Result | Detail |\n|---|---|---|\n';
  for (const c of checks) md += `| \`${cell(c.check)}\` | ${cell(c.result)} | ${cell(c.detail).slice(0, 200)} |\n`;
  if (!checks.length) md += '| (checks.json missing) | | |\n';

  const full = (f) => {
    let s = `### ${f.id} · ${f.severity} · ${f.category} · ${f.title}\n\n`;
    s += `- **Where:** ${where(f)}\n`;
    s += `- **What goes wrong:** ${f.failure_scenario || ''}\n`;
    if (f.evidence) s += `- **Evidence:**\n\n\`\`\`\n${String(f.evidence).trim()}\n\`\`\`\n\n`;
    if (f.verifier) {
      s += `- **Verifier (${f.verifier.group}):** ${f.verifier.reason || ''}`;
      if (f.verifier.severity_changed_because) s += ` Severity: ${f.verifier.severity_changed_because}`;
      if (f.verifier.repro) s += ` Repro: \`${f.verifier.repro}\``;
      s += '\n';
    } else if (f.verify === 'checked') s += '- **Verifier:** automated check failure\n';
    s += `- **Proposed fix:** ${f.proposed_fix || ''}`;
    if ((f.fix_touches || []).length) s += ` · touches: ${f.fix_touches.join(', ')}`;
    s += `\n- **Found by:** ${[].concat(f.found_by).join(', ')}${f.merged_from && f.merged_from.length ? ` (merged ${f.merged_from.join(', ')})` : ''}\n\n`;
    return s;
  };

  md += '\n## Confirmed findings\n\nRanked: severity, then security, functionality, optimization, format.\n\n';
  md += confirmed.length ? confirmed.map(full).join('') : 'None.\n\n';

  md += '## Needs a human check\n\nDepends on something outside the repo.\n\n';
  const nh = is('needs-human');
  md += nh.length ? nh.map((f) => `- **${f.id} · ${f.severity} · ${f.title}** (${where(f)}) — check: ${f.verifier.reason || ''}\n`).join('') : 'None.\n';

  // Candidate fix batches: confirmed findings whose fixes touch a shared file.
  const uf = unionFind(confirmed.length);
  const touch = confirmed.map((f) => new Set((f.fix_touches && f.fix_touches.length ? f.fix_touches : (f.files || []).map((x) => x.path))));
  for (let i = 0; i < confirmed.length; i++) for (let j = i + 1; j < confirmed.length; j++) {
    if ([...touch[i]].some((p) => touch[j].has(p))) uf.join(i, j);
  }
  md += '\n## Proposed fix batches\n\n';
  md += '<!-- ROOT: candidate batches below are grouped only by shared files. Split or regroup by root cause, name each batch, and replace this comment. -->\n\n';
  md += '| Batch | Findings | Files touched | Notes |\n|---|---|---|---|\n';
  uf.groups().forEach((g, n) => {
    const files = [...new Set(g.flatMap((i) => [...touch[i]]))];
    md += `| ${n + 1} | ${g.map((i) => confirmed[i].id).join(', ')} | ${files.join(', ')} | |\n`;
  });

  const low = is('skipped-low');
  md += '\n## Low findings (not verified)\n\nSent straight from the reviewers to save verifier cost. Treat as leads.\n\n';
  md += low.length ? low.map((f) => `- ${f.id} · ${f.category} · ${f.title} (${where(f)})\n`).join('') : 'None.\n';

  const unv = [...is('skipped-budget'), ...is('unverified')];
  if (unv.length) {
    md += '\n## Not verified\n\nOver the verifier budget, or no verdict came back.\n\n';
    md += unv.map((f) => `- ${f.id} · ${f.severity} · ${f.category} · ${f.title} (${where(f)})\n`).join('');
  }

  md += '\n## Unreviewed\n\n';
  md += cov.unreviewed && cov.unreviewed.length
    ? '| Area | Files | Categories |\n|---|---|---|\n' + cov.unreviewed.map((u) => `| ${u.area} | ${u.files.join(', ')} | ${u.categories.join(', ')} |`).join('\n') + '\n'
    : 'None.\n';

  md += '\n## Agent changes outside the run folder\n\n';
  const outside = path.join(runDir, 'outside.txt');
  md += fs.existsSync(outside)
    ? 'Changed while the audit ran. Nothing was reverted: check each one, since some may be your own edits made during the run.\n\n```\n' + fs.readFileSync(outside, 'utf8').trim() + '\n```\n'
    : 'None.\n';

  md += '\n## Appendix: rejected findings\n\nCopy any you agree with into `.claude/skills/audit/decisions.md` so later audits skip them.\n\n';
  const rej = is('rejected');
  md += '| ID | Title | Verifier\'s reason |\n|---|---|---|\n';
  md += rej.map((f) => `| ${f.id} | ${cell(f.title)} | ${cell(f.verifier.reason)} |`).join('\n') + (rej.length ? '\n' : '| | none | |\n');
  if (dropped && dropped.length) {
    md += '\nDropped by the root before verification:\n\n';
    md += dropped.map((d) => `- ${d.id} · ${d.title} — ${d.reason}`).join('\n') + '\n';
  }
  md += '\n## Appendix: conventions draft\n\nSee `conventions-draft.md` in this run folder.\n';

  writeOut('report.md', md);
  console.log(`report.md written: ${confirmed.length} confirmed, ${nh.length} needs-human, ${low.length} low unverified, ${rej.length} rejected, coverage ${cov.pct}%.`);
  console.log('Finish the "Proposed fix batches" section.');
}

// ---------- main ----------

const commands = { snapshot, coverage, findings, apply, report };
if (!commands[command]) {
  console.error(`Unknown command "${command}". Use snapshot, coverage, findings, apply or report.`);
  process.exit(2);
}
try {
  commands[command]();
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}
