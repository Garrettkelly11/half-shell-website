#!/usr/bin/env node
/**
 * audit-guard.js — Claude Code PreToolUse hook (wired in .claude/settings.json).
 *
 * While an /audit run is active, blocks any write outside that run's folder.
 * Outside an audit it does nothing, so normal editing and the fix phase are unaffected.
 *
 * "Active" means audit/runs/.active exists and is less than 6 hours old.
 * `merge.js <run folder> init` creates it; `merge.js <run folder> finish` removes it.
 * If a run crashes and leaves it behind, it stops counting after 6 hours, or delete
 * audit/runs/.active by hand.
 *
 * Blocks (exit 2, reason sent back to the agent):
 *   - Write / Edit / MultiEdit / NotebookEdit to a path outside the run folder
 *   - Bash: git commands that change files or history, firebase, gcloud, sed -i,
 *     rm/mv/cp/tee/truncate on paths outside audit/runs/, shell redirection (> or >>)
 *     to a file outside audit/runs/, node -e scripts that write files outside audit/runs/
 *
 * It is a guard rail, not a sandbox: a determined script could still get round it. The
 * end-of-run snapshot (merge.js snapshot end) is what catches anything that slips through.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_AGE_MS = 6 * 60 * 60 * 1000;

function main(input) {
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const marker = path.join(root, 'audit', 'runs', '.active');
  let active;
  try {
    const st = fs.statSync(marker);
    if (Date.now() - st.mtimeMs > MAX_AGE_MS) return ok();
    active = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch {
    return ok(); // no audit running
  }
  const runDir = path.resolve(root, active.run || 'audit/runs/__none__');
  const runsDir = path.resolve(root, 'audit', 'runs');
  const inside = (p, dir) => {
    if (!p) return false;
    const abs = path.resolve(input.cwd || root, String(p).replace(/^["']|["']$/g, ''));
    const rel = path.relative(dir, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const why = (what) => block(
    `Blocked by audit-guard: an /audit run is active (${active.run}). ${what} ` +
    'Audit agents write only inside their run folder. Describe the change in proposed_fix instead; ' +
    'a failing check is a finding, never something to fix during the audit.');

  const tool = input.tool_name;
  const ti = input.tool_input || {};

  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const target = ti.file_path || ti.notebook_path;
    if (!inside(target, runDir)) return why(`${tool} to ${target} is outside the run folder.`);
    return ok();
  }

  if (tool !== 'Bash') return ok();
  const cmd = String(ti.command || '');

  if (/\bgit\s+(-C\s+\S+\s+)?(commit|push|add|merge|rebase|reset|checkout|switch|restore|stash|clean|tag|am|apply|cherry-pick|revert|mv|rm|branch\s+-[dDmM]|config)\b/.test(cmd)) {
    return why('git commands that change files, branches or history are not allowed.');
  }
  if (/(^|[\s;&|(])(npx\s+)?(firebase|gcloud|gsutil)\b/.test(cmd) && !/\bnpm\s+(test|run\s+test)\b/.test(cmd)) {
    return why('firebase / gcloud commands are not allowed (tools/rules-test runs through npm test).');
  }
  if (/\bsed\b[^|;&]*\s(-[a-zA-Z]*i\b|--in-place)/.test(cmd)) return why('sed -i edits files in place.');

  // Quoted strings (node -e scripts, messages) are masked so "a > b" inside them isn't
  // read as a redirect; a quoted path argument is restored before it is checked.
  const quotes = [];
  const masked = cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (q) => `\u0000${quotes.push(q) - 1}\u0000`);
  const unq = (t) => t.replace(/\u0000(\d+)\u0000/g, (_, i) => quotes[i]).replace(/^["']|["']$/g, '');

  // rm / mv / cp / tee / truncate: every path argument must be inside audit/runs/.
  const fileCmd = /(?:^|[\s;&|(])(rm|rmdir|mv|cp|tee|truncate|unlink|del)\s+([^;&|]*)/g;
  let m;
  while ((m = fileCmd.exec(masked))) {
    const args = m[2].trim().split(/\s+/).filter((a) => a && !a.startsWith('-')).map(unq);
    // cp may read from anywhere; only its last argument (the destination) must be inside.
    const targets = m[1] === 'cp' ? args.slice(-1) : args;
    const bad = targets.filter((a) => !inside(a, runsDir));
    if (bad.length) return why(`${m[1]} on ${bad.join(', ')} is outside audit/runs/.`);
  }

  // Shell redirection to a file.
  const redir = /(?:^|[^0-9&>=<-])(\d?)>>?\s*([^\s;&|)]+)/g;
  while ((m = redir.exec(masked))) {
    const t = unq(m[2]);
    if (t.startsWith('&') || t.startsWith('=') || t === '/dev/null' || /^nul$/i.test(t)) continue;
    if (!inside(t, runsDir)) return why(`Redirecting output to ${t} writes outside audit/runs/.`);
  }

  // Inline node scripts that write files.
  if (/\bnode\b[^;&|]*\s-(e|p)\b/.test(cmd)
      && /\b(writeFile|appendFile|unlink|rename|rmSync|rmdir|copyFile|createWriteStream|truncate)/.test(cmd)
      && !/audit[\\/]runs[\\/]/.test(cmd)) {
    return why('This node -e script writes files outside audit/runs/. Write them inside the run folder.');
  }
  return ok();
}

function ok() { process.exit(0); }
function block(msg) { process.stderr.write(msg + '\n'); process.exit(2); }

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { return ok(); }
  try { main(input); } catch (e) {
    // A bug in the guard must not lock Garrett out of normal work; fail open, say why.
    process.stderr.write(`audit-guard error (allowed): ${e.message}\n`);
    process.exit(0);
  }
});
