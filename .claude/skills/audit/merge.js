#!/usr/bin/env node
/**
 * merge.js — bookkeeping for /audit, so the root agent never has to read every
 * agent's file into its own context.
 *
 * Terminal, from the repo root:
 *   node .claude/skills/audit/merge.js <run folder> init [goal] [area ...] [focus: free text]
 *   node .claude/skills/audit/merge.js <run folder> validate [agents/<id>.json | verdicts/<id>.json ...]
 *   node .claude/skills/audit/merge.js <run folder> finish
 *   node .claude/skills/audit/merge.js <run folder> snapshot start
 *   node .claude/skills/audit/merge.js <run folder> snapshot end
 *   node .claude/skills/audit/merge.js <run folder> coverage
 *   node .claude/skills/audit/merge.js <run folder> findings
 *   node .claude/skills/audit/merge.js <run folder> apply
 *   node .claude/skills/audit/merge.js <run folder> report
 *
 * init      Creates the run folder, writes run.json (commit, uncommitted files, budgets, the
 *           goal from goals.json, areas, focus), writes audit/runs/.active (which turns on
 *           .claude/hooks/audit-guard.js, blocking writes outside the run folder), and takes
 *           the start snapshot. The first argument is a goal id if it matches one in goals.json
 *           (default "full"); "focus:" starts free text passed to every agent.
 * validate  Checks agent and verifier files against finding-schema.md, so every file can be
 *           compiled into the report. With file arguments, checks just those (agents run this
 *           on their own file before returning); without, checks everything and writes
 *           validation.json, which the report lists. Exit code 1 if anything fails.
 * finish    Removes audit/runs/.active. Run it last, after the report is finished.
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
  console.error('Usage: node merge.js <run folder> init|validate|snapshot|coverage|findings|apply|report|finish');
  process.exit(2);
}
const SKILL_DIR = __dirname;

// The run's goal (from run.json, written by init). Old runs without one are full audits.
function goalOf(run) {
  const g = run.goal || {};
  const cats = (g.categories || []).filter((c) => CATEGORIES.includes(c));
  return {
    id: g.id || 'full',
    name: g.name || 'Full audit',
    categories: cats.length ? cats : CATEGORIES,
    verify_low: Boolean(g.verify_low),
    focus: run.focus || '',
  };
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

const readWarnings = [];

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
      readWarnings.push(`${dir}/${name} skipped: not valid JSON (${e.message})`);
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

// ---------- init / finish ----------

function repoRoot() {
  const { execFileSync } = require('child_process');
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function markerPath() {
  return path.join(repoRoot(), 'audit', 'runs', '.active');
}

function init() {
  const { execFileSync } = require('child_process');
  const root = repoRoot();
  const args = process.argv.slice(4).join(' ').trim();
  const goals = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'goals.json'), 'utf8')).goals;
  const areaIds = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'areas.json'), 'utf8')).areas.map((a) => a.id);

  let focus = '';
  let rest = args;
  const fi = args.search(/\bfocus:/i);
  if (fi >= 0) { focus = args.slice(fi + 6).trim().replace(/^["']|["']$/g, ''); rest = args.slice(0, fi); }
  const tokens = rest.split(/\s+/).filter(Boolean);
  let goalId = 'full';
  if (tokens[0] && goals[tokens[0].toLowerCase()]) goalId = tokens.shift().toLowerCase();
  const unknown = tokens.filter((t) => !areaIds.includes(t));
  if (unknown.length) {
    throw new Error(`Unknown goal or area: ${unknown.join(', ')}. Goals: ${Object.keys(goals).join(', ')}. Areas: ${areaIds.join(', ')}.`);
  }
  const g = goals[goalId];
  let areas = tokens.length ? tokens : ['all'];
  if (tokens.length >= 2 && !areas.includes('seams')) areas.push('seams');
  // Areas the goal skips (e.g. conventions for a security run).
  const leads = (areas.includes('all') ? areaIds : areas).filter((a) => !(g.skip_areas || []).includes(a));

  if (fs.existsSync(path.join(runDir, 'run.json'))) throw new Error(`${runDir} already has run.json; pick a new run id.`);
  for (const d of ['requests', 'agents', 'verdicts', 'scratch']) fs.mkdirSync(path.join(runDir, d), { recursive: true });

  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
    .split('\n').map((l) => l.trimEnd()).filter((l) => l && !/audit\/runs\//.test(l));
  const run = {
    run_id: path.basename(path.resolve(runDir)),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    started: new Date().toISOString(),
    areas,
    leads,
    goal: { id: goalId, name: g.name, categories: g.categories, verify_low: g.verify_low, brief: g.brief, checklist: g.checklist || [] },
    focus,
    uncommitted: status,
    budgets: { discovery: 25, verifiers: 15, group_size: 6, verify_low: Boolean(g.verify_low) },
  };
  writeOut('run.json', run);
  const rel = path.relative(root, path.resolve(runDir)).split(path.sep).join('/');
  fs.writeFileSync(markerPath(), JSON.stringify({ run: rel, started: run.started }) + '\n');
  snapshotStart();
  console.log(`Run ${run.run_id}: goal "${g.name}" (${g.categories.join(', ')}); areas ${areas.join(', ')}; leads: ${leads.join(', ')}.`);
  if (focus) console.log(`Focus: ${focus}`);
  console.log(`${status.length} uncommitted or untracked files. Write guard on (audit/runs/.active).`);
}

function finish() {
  const m = markerPath();
  if (fs.existsSync(m)) fs.unlinkSync(m);
  console.log('Write guard off (audit/runs/.active removed).');
  const outside = path.join(runDir, 'outside.txt');
  if (fs.existsSync(outside)) {
    console.log(`WARNING: files changed outside the run folder during the audit. Tell Garrett; do not say "no site code was changed":`);
    console.log(fs.readFileSync(outside, 'utf8').trim());
  } else {
    console.log('No files changed outside the run folder.');
  }
}

// ---------- validate ----------

const ROLES = ['scout', 'lead', 'specialist', 'checks'];
const LINES_RE = /^\d+(-\d+)?$/;

function validateFinding(f, ownerId, root, out, where) {
  const p = (msg) => out.push(`${where}: ${msg}`);
  if (!f || typeof f !== 'object') return p('finding is not an object');
  const id = f.id || '?';
  const req = ['id', 'area', 'category', 'severity', 'title', 'files', 'failure_scenario', 'evidence', 'proposed_fix', 'fix_touches', 'confidence', 'found_by'];
  for (const k of req) if (f[k] === undefined || f[k] === null || f[k] === '') p(`${id}: missing "${k}"`);
  if (f.id && ownerId && ownerId !== 'checks' && !String(f.id).startsWith(`${ownerId}-F`)) p(`${id}: id must start with "${ownerId}-F"`);
  if (f.id && ownerId === 'checks' && !/^CHK-\d+$/.test(f.id)) p(`${id}: check findings use CHK-NN`);
  if (f.category && !CATEGORIES.includes(f.category)) p(`${id}: category "${f.category}" not one of ${CATEGORIES.join('|')}`);
  if (f.severity && !SEVERITIES.includes(f.severity)) p(`${id}: severity "${f.severity}" not one of ${SEVERITIES.join('|')}`);
  if (f.confidence && !['high', 'medium', 'low'].includes(f.confidence)) p(`${id}: confidence "${f.confidence}" not high|medium|low`);
  if (f.title && String(f.title).length > 100) p(`${id}: title over 100 characters`);
  if (f.files !== undefined) {
    if (!Array.isArray(f.files) || !f.files.length) p(`${id}: "files" must be a non-empty array of {path, lines}`);
    else for (const x of f.files) {
      if (!x || typeof x !== 'object' || !x.path) { p(`${id}: each files entry needs "path"`); continue; }
      if (x.lines !== undefined && x.lines !== '' && !LINES_RE.test(String(x.lines))) p(`${id}: lines "${x.lines}" must look like "120" or "120-134"; use one files entry per range`);
      if (root && !fs.existsSync(path.join(root, x.path))) p(`${id}: file "${x.path}" does not exist`);
    }
  }
  if (f.fix_touches !== undefined && !Array.isArray(f.fix_touches)) p(`${id}: "fix_touches" must be an array`);
}

function validateAgentFile(name, d, root, out) {
  const where = `agents/${name}`;
  const p = (msg) => out.push(`${where}: ${msg}`);
  const expect = name.replace(/\.json$/, '');
  if (d.id !== expect) p(`"id" is "${d.id}", must match the file name ("${expect}")`);
  if (!ROLES.includes(d.role)) p(`"role" "${d.role}" not one of ${ROLES.join('|')}`);
  if (d.role !== 'checks' && !['done', 'partial'].includes(d.status)) p(`"status" must be done|partial`);
  if (!Array.isArray(d.findings)) p('"findings" must be an array (empty if none)');
  if (!Array.isArray(d.coverage)) p('"coverage" must be an array (empty if none)');
  if (d.role === 'scout' && Array.isArray(d.coverage) && d.coverage.length) p('the scout reviews nothing; "coverage" must be empty');
  if (/^(L|S)-/.test(expect)) {
    if (!Array.isArray(d.spawned)) p('"spawned" must be an array (empty if none)');
    if (!d.spawn_decision || typeof d.spawn_decision !== 'string') p('"spawn_decision" is required: why you did or did not spawn, and whether you had the Agent tool');
  }
  if (d.role === 'specialist' && !d.answer) p('"answer" is required');
  (d.role === 'scout' ? [] : d.coverage || []).forEach((e, i) => {
    if (!e || typeof e !== 'object') return p(`coverage[${i}] is not an object`);
    if (!e.file) p(`coverage[${i}]: missing "file"`);
    else if (root && !fs.existsSync(path.join(root, e.file))) p(`coverage[${i}]: file "${e.file}" does not exist`);
    if (!CATEGORIES.includes(e.category)) p(`coverage[${i}] (${e.file}): category "${e.category}" not one of ${CATEGORIES.join('|')}`);
    if (!Object.keys(RESULT_RANK).includes(e.result)) p(`coverage[${i}] (${e.file}): result "${e.result}" not one of cleared|findings|n/a|unreviewed`);
    if ((e.result === 'cleared' || e.result === 'n/a') && !e.note) p(`coverage[${i}] (${e.file}): "${e.result}" needs a note saying what was checked or why n/a`);
  });
  (d.findings || []).forEach((f, i) => validateFinding(f, d.id, root, out, `${where} findings[${i}]`));
  // A coverage cell marked "findings" should have a finding that cites that file.
  const cited = new Set((d.findings || []).flatMap((f) => (f && f.files || []).map((x) => x && x.path)));
  for (const e of d.coverage || []) {
    if (e && e.result === 'findings' && e.file && !cited.has(e.file)) p(`coverage (${e.file}, ${e.category}) says "findings" but no finding in this file cites ${e.file}`);
  }
}

function validateVerdictFile(name, d, out) {
  const where = `verdicts/${name}`;
  const p = (msg) => out.push(`${where}: ${msg}`);
  const expect = name.replace(/\.json$/, '');
  if (d.id !== expect) p(`"id" is "${d.id}", must match the file name ("${expect}")`);
  if (!Array.isArray(d.verdicts)) return p('"verdicts" must be an array');
  let group = null;
  try { group = JSON.parse(fs.readFileSync(path.join(runDir, 'verify', name), 'utf8')); } catch { p(`no verify/${name} to check against`); }
  const ids = group ? group.findings.map((f) => f.id) : [];
  d.verdicts.forEach((v, i) => {
    const w = `verdicts[${i}] (${v && v.finding})`;
    if (!v || typeof v !== 'object') return p(`${w} is not an object`);
    if (group && !ids.includes(v.finding)) p(`${w}: "${v.finding}" is not in this group (${ids.join(', ')})`);
    if (!['confirmed', 'rejected', 'needs-human'].includes(v.verdict)) p(`${w}: verdict "${v.verdict}" not confirmed|rejected|needs-human`);
    if (!SEVERITIES.includes(v.severity)) p(`${w}: "severity" is required (${SEVERITIES.join('|')})`);
    if (!v.reason) p(`${w}: "reason" is required`);
    const orig = group && group.findings.find((f) => f.id === v.finding);
    if (orig && v.severity && v.severity !== orig.severity && !v.severity_changed_because) p(`${w}: severity changed from ${orig.severity} to ${v.severity} without "severity_changed_because"`);
  });
  for (const id of ids) if (!d.verdicts.some((v) => v && v.finding === id)) p(`no verdict for ${id}`);
}

function validateRequest(name, d, out) {
  const p = (msg) => out.push(`requests/${name}: ${msg}`);
  if (d.id !== name.replace(/\.json$/, '')) p(`"id" must match the file name`);
  if (!(Number.isInteger(d.layer) && d.layer >= 1 && d.layer <= 5)) p('"layer" must be 1-5');
  if (d.layer >= 2 && !d.parent) p('"parent" is required at layer 2+');
}

function validate() {
  let root = null;
  try { root = repoRoot(); } catch { /* path checks skipped outside a repo */ }
  const only = process.argv.slice(4);
  const out = [];
  const files = only.length ? only : [
    ...readNames('agents').map((n) => `agents/${n}`),
    ...readNames('verdicts').map((n) => `verdicts/${n}`),
    ...readNames('requests').map((n) => `requests/${n}`),
  ];
  for (const rel of files) {
    const norm = rel.replace(/\\/g, '/').replace(new RegExp(`^.*?(agents|verdicts|requests)/`), '$1/');
    const abs = path.join(runDir, norm);
    let d;
    try { d = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { out.push(`${norm}: not valid JSON (${e.message})`); continue; }
    const [dir, name] = norm.split('/');
    if (dir === 'agents') validateAgentFile(name, d, root, out);
    else if (dir === 'verdicts') validateVerdictFile(name, d, out);
    else if (dir === 'requests') validateRequest(name, d, out);
    else out.push(`${norm}: not under agents/, verdicts/ or requests/`);
  }
  if (!only.length) writeOut('validation.json', { checked: files.length, problems: out });
  if (out.length) {
    for (const l of out) console.log(`PROBLEM: ${l}`);
    console.log(`${out.length} problems in ${files.length} files. Fix the file(s) and run validate again.`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${files.length} file(s) valid.`);
  }
}

function readNames(dir) {
  const p = path.join(runDir, dir);
  return fs.existsSync(p) ? fs.readdirSync(p).filter((n) => n.endsWith('.json')).sort() : [];
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

function snapshotStart() {
  const files = hashTree();
  writeOut('snapshot-start.json', { time: new Date().toISOString(), files });
  console.log(`Snapshot taken: ${Object.keys(files).length} files.`);
}

function snapshot() {
  const phase = process.argv[4];
  if (phase === 'start') return snapshotStart();
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

// The audit tool's own files are never audited.
const OUT_OF_SCOPE = ['.claude/', 'audit/'];

function inScopeFiles(map, run) {
  const areas = run.areas && !run.areas.includes('all') ? new Set(run.areas) : null;
  return (map.files || []).filter((f) =>
    f && f.path
    && !OUT_OF_SCOPE.some((p) => f.path.startsWith(p))
    && (!areas || areas.has(f.area)));
}

function coverage() {
  const map = readJson('map.json');
  const run = readJson('run.json', {});
  const files = inScopeFiles(map, run);
  const GCATS = goalOf(run).categories; // only the goal's categories count toward coverage
  const grid = {};
  for (const f of files) {
    grid[f.path] = {};
    for (const c of GCATS) {
      // Generated and dead files default to n/a; agents can still override with a real result.
      const def = f.status === 'generated' ? { result: 'n/a', note: 'generated', by: 'scout' }
        : f.status === 'dead' ? { result: 'n/a', note: 'dead file', by: 'scout' }
        : { result: 'unreviewed', note: '', by: '' };
      grid[f.path][c] = def;
    }
  }

  const unknown = new Set();
  const malformed = [];
  for (const a of agents()) {
    for (const e of a.coverage || []) {
      if (!e || typeof e !== 'object' || !e.file || !CATEGORIES.includes(e.category)) {
        malformed.push(a.id || '?');
        continue;
      }
      if (!grid[e.file]) { unknown.add(e.file); continue; }
      if (!GCATS.includes(e.category)) continue; // outside this run's goal
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
    for (const c of GCATS) {
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

  writeOut('coverage.json', { scope: run.areas || ['all'], categories: GCATS, files: files.length, total, done, pct, unreviewed, unknown_files: [...unknown], grid });

  const short = { findings: 'F', cleared: 'ok', 'n/a': 'n/a', unreviewed: '—' };
  let md = `# Coverage\n\n${done} of ${total} cells (${pct}%). F = findings, ok = cleared, — = unreviewed.\n\n`;
  md += `| File | ${GCATS.join(' | ')} |\n|---|${GCATS.map(() => '---').join('|')}|\n`;
  for (const [file, cats] of Object.entries(grid)) {
    md += `| ${cell(file)} | ${GCATS.map((c) => short[cats[c].result] || cats[c].result).join(' | ')} |\n`;
  }
  writeOut('coverage.md', md);

  const scope = run.areas && !run.areas.includes('all') ? `areas ${run.areas.join(', ')}` : 'all areas';
  console.log(`Coverage (${scope}, ${files.length} files): ${done}/${total} cells (${pct}%).`);
  if (malformed.length) {
    const by = [...new Set(malformed)];
    console.log(`PROBLEM: ${malformed.length} coverage entries not in {file, category, result} form, from ${by.join(', ')}; ignored.`);
  }
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
  const goal = goalOf(run);
  const verifyLow = Boolean((run.budgets && run.budgets.verify_low) || goal.verify_low);

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
    else if (!goal.categories.includes(f.category)) f.verify = 'off-goal';
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
  const offGoal = merged.filter((f) => f.verify === 'off-goal').length;
  if (offGoal) console.log(`${offGoal} findings outside the goal (${goal.categories.join(', ')}) listed separately, not verified.`);
  if (over.size) console.log(`${over.size} findings not verified: over budget.`);
  for (const p of problems) console.log(`PROBLEM: ${p}`);
}

// ---------- report ----------

function report() {
  const run = readJson('run.json', {});
  const goal = goalOf(run);
  const outsidePath = path.join(runDir, 'outside.txt');
  const outsideLines = fs.existsSync(outsidePath) ? fs.readFileSync(outsidePath, 'utf8').trim().split('\n').filter(Boolean) : [];
  const validation = readJson('validation.json', null);
  const agentFiles = readDir('agents').map((a) => a.data);
  const { findings: merged, dropped } = readJson('findings-merged.json');
  const cov = readJson('coverage.json', { total: 0, done: 0, pct: 0, unreviewed: [] });
  const checks = readJson('checks.json', []);
  const requests = readDir('requests').map((r) => r.data);
  const verdicts = new Map();
  const verdictProblems = [];
  for (const v of readDir('verdicts')) {
    for (const x of v.data.verdicts || []) {
      // Accept near-miss field names so one sloppy verifier doesn't blank the report.
      const reason = x.reason || x.note || x.notes || x.explanation || x.comment || '';
      if (!reason) verdictProblems.push(`${v.data.id}: no reason for ${x.finding}`);
      if (!['confirmed', 'rejected', 'needs-human'].includes(x.verdict)) verdictProblems.push(`${v.data.id}: unknown verdict "${x.verdict}" for ${x.finding}`);
      verdicts.set(x.finding, { ...x, reason, group: v.data.id });
    }
  }

  for (const f of merged) {
    const v = verdicts.get(f.id);
    if (f.verify === 'checked') f.status = 'confirmed';
    else if (f.verify === 'off-goal') f.status = 'off-goal';
    else if (v) {
      f.status = v.verdict;
      f.verifier = v;
      f.found_severity = f.severity;
      if (v.severity && SEVERITIES.includes(v.severity)) f.severity = v.severity;
      else verdictProblems.push(`${v.group}: no severity for ${f.id}; kept the reviewer's ${f.severity}`);
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
  md += `Commit \`${run.commit || '?'}\` · Goal: ${goal.name} (${goal.categories.join(', ')}) · Areas: ${(run.areas || ['all']).join(', ')}\n\n`;
  if (goal.focus) md += `Focus: ${goal.focus}\n\n`;
  md += outsideLines.length
    ? `**Warning: ${outsideLines.length} file(s) outside the run folder changed while the audit ran** (see "Changes outside the run folder"). Check them before trusting the working copy.\n\n`
    : 'No files outside the run folder changed during the audit.\n\n';
  if (run.uncommitted && run.uncommitted.length) {
    md += `Audited the working copy as it was, including ${run.uncommitted.length} uncommitted or untracked files: ${run.uncommitted.map((u) => `\`${u}\``).join(', ')}.\n\n`;
  }

  md += '## Summary\n\nConfirmed findings (plus automated check failures):\n\n';
  md += `| | ${SEVERITIES.map((s) => s[0].toUpperCase() + s.slice(1)).join(' | ')} |\n|---|${SEVERITIES.map(() => '---').join('|')}|\n`;
  // Goal categories, plus any category an automated check failure landed in.
  const rows = ['security', 'functionality', 'optimization', 'format']
    .filter((x) => goal.categories.includes(x) || confirmed.some((f) => f.verify === 'checked' && f.category === x));
  for (const c of rows) {
    md += `| ${c[0].toUpperCase() + c.slice(1)} | ${SEVERITIES.map((s) => confirmed.filter((f) => f.category === c && f.severity === s).length || '').join(' | ')} |\n`;
  }
  md += `\nAlso: ${is('needs-human').length} need a human check · ${is('skipped-low').length} low not verified · `;
  md += `${is('skipped-budget').length + is('unverified').length} not verified (budget or missing verdict) · ${is('rejected').length} rejected`;
  md += goal.categories.length < CATEGORIES.length ? ` · ${is('off-goal').length} outside the goal.\n\n` : '.\n\n';
  if (validation && validation.problems.length) md += `Agent output problems: ${validation.problems.length} (see "Agent output problems"; affected findings may be missing).\n\n`;
  md += `Coverage: ${cov.done} of ${cov.total} cells (${cov.pct}%), ${(cov.scope || ['all']).includes('all') ? 'all areas' : 'areas ' + cov.scope.join(', ')}.\n\n`;
  md += `Agents: ${discovery}/${b.discovery ?? '?'} discovery, ${verifierCount}/${b.verifiers ?? '?'} verifier. By layer: ${layers}.\n\n`;

  md += '## Automated checks\n\n| Check | Result | Detail |\n|---|---|---|\n';
  for (const c of checks) {
    const d = cell(c.detail);
    md += `| \`${cell(c.check)}\` | ${cell(c.result)} | ${d.length > 160 ? d.slice(0, 160) + '… (full below)' : d} |\n`;
  }
  if (!checks.length) md += '| (checks.json missing) | | |\n';
  const notPassed = checks.filter((c) => c.result !== 'pass');
  if (notPassed.length) {
    md += '\nChecks that did not pass, in full:\n\n';
    for (const c of notPassed) md += `- \`${c.check}\` (${c.result}):\n\n  \`\`\`\n  ${String(c.detail || '').trim().replace(/\n/g, '\n  ')}\n  \`\`\`\n`;
  }

  const full = (f) => {
    let s = `### ${f.id} · ${f.severity} · ${f.category} · ${f.title}\n\n`;
    s += `- **Where:** ${where(f)}\n`;
    s += `- **What goes wrong:** ${f.failure_scenario || ''}\n`;
    if (f.evidence) s += `- **Evidence:**\n\n\`\`\`\n${String(f.evidence).trim()}\n\`\`\`\n\n`;
    if (f.verifier) {
      s += `- **Verifier (${f.verifier.group}):** ${f.verifier.reason || ''}`;
      if (f.found_severity && f.found_severity !== f.severity) s += ` Severity ${f.found_severity} → ${f.severity}: ${f.verifier.severity_changed_because || '(no reason given)'}`;
      else if (f.verifier.severity_changed_because) s += ` Severity: ${f.verifier.severity_changed_because}`;
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

  const off = is('off-goal');
  if (off.length) {
    md += `\n## Outside this run's goal (not verified)\n\nFound while looking for ${goal.categories.join(', ')} issues. Treat as leads.\n\n`;
    md += off.map((f) => `- ${f.id} · ${f.severity} · ${f.category} · ${f.title} (${where(f)})\n`).join('');
  }

  const unv = [...is('skipped-budget'), ...is('unverified')];
  if (unv.length) {
    md += '\n## Not verified\n\nOver the verifier budget, or no verdict came back.\n\n';
    md += unv.map((f) => `- ${f.id} · ${f.severity} · ${f.category} · ${f.title} (${where(f)})\n`).join('');
  }

  md += '\n## Unreviewed\n\n';
  md += cov.unreviewed && cov.unreviewed.length
    ? '| Area | Files | Categories |\n|---|---|---|\n' + cov.unreviewed.map((u) => `| ${u.area} | ${u.files.join(', ')} | ${u.categories.join(', ')} |`).join('\n') + '\n'
    : 'None.\n';

  md += '\n## Changes outside the run folder\n\n';
  md += outsideLines.length
    ? 'Changed while the audit ran. Nothing was reverted: check each one, since some may be your own edits made during the run. An agent change here also needs a Changelog.md entry if you keep it.\n\n```\n' + outsideLines.join('\n') + '\n```\n'
    : 'None.\n';

  md += '\n## Agent tree\n\nWho spawned whom, and why each lead or specialist did or didn\'t split its work.\n\n';
  const treeRows = agentFiles.filter((a) => /^(L|S|SW)-/.test(String(a.id)));
  md += treeRows.length
    ? '| Agent | Layer | Spawned | Why |\n|---|---|---|---|\n' + treeRows.map((a) => {
      const req = requests.find((r) => r.id === a.id) || {};
      return `| ${a.id} | ${a.layer ?? req.layer ?? 1} | ${(a.spawned || []).join(', ') || '—'} | ${cell(a.spawn_decision || '(not given)')} |`;
    }).join('\n') + '\n'
    : 'No lead or specialist files.\n';

  const outputProblems = [...new Set([...(validation ? validation.problems : []), ...readWarnings])];
  md += '\n## Agent output problems\n\n';
  md += validation ? '' : '`merge.js validate` was not run for this report.\n\n';
  md += outputProblems.length ? outputProblems.map((x) => `- ${x}`).join('\n') + '\n' : (validation ? 'None. Every agent and verifier file passed validation.\n' : '');

  md += '\n## Appendix: rejected findings\n\nCopy any you agree with into `.claude/skills/audit/decisions.md` so later audits skip them.\n\n';
  const rej = is('rejected');
  md += '| ID | Title | Verifier\'s reason |\n|---|---|---|\n';
  md += rej.map((f) => `| ${f.id} | ${cell(f.title)} | ${cell(f.verifier.reason)} |`).join('\n') + (rej.length ? '\n' : '| | none | |\n');
  if (dropped && dropped.length) {
    md += '\nDropped by the root before verification:\n\n';
    md += dropped.map((d) => `- ${d.id} · ${d.title} — ${d.reason}`).join('\n') + '\n';
  }
  if (fs.existsSync(path.join(runDir, 'conventions-draft.md'))) {
    md += '\n## Appendix: conventions draft\n\nSee `conventions-draft.md` in this run folder.\n';
  }

  writeOut('report.md', md);
  console.log(`report.md written: ${confirmed.length} confirmed, ${nh.length} needs-human, ${low.length} low unverified, ${rej.length} rejected, coverage ${cov.pct}%.`);
  for (const p of verdictProblems) console.log(`PROBLEM: ${p}`);
  if (outsideLines.length) console.log(`WARNING: ${outsideLines.length} file(s) changed outside the run folder. Say so to Garrett; do not say no site code was changed.`);
  if (!validation) console.log('PROBLEM: validation.json missing; run merge.js validate before report.');
  console.log('Finish the "Proposed fix batches" section, then run merge.js finish.');
}

// ---------- main ----------

const commands = { init, validate, finish, snapshot, coverage, findings, apply, report };
if (!commands[command]) {
  console.error(`Unknown command "${command}". Use init, validate, snapshot, coverage, findings, apply, report or finish.`);
  process.exit(2);
}
try {
  commands[command]();
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}
