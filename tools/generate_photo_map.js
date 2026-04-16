#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function usage() {
  console.log('Usage: node tools/generate_photo_map.js [--dir <assets/oysters>] [--files <file1> <file2> ...] [--write]');
  process.exit(1);
}

const argv = process.argv.slice(2);
let dir = 'assets/oysters';
let files = ['index.html','oyster.html'];
let write = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dir') { dir = argv[++i]; }
  else if (a === '--files') {
    files = [];
    while (argv[i+1] && !argv[i+1].startsWith('--')) files.push(argv[++i]);
  } else if (a === '--write') { write = true; }
  else if (a === '--help' || a === '-h') usage();
  else usage();
}

function slugName(filename) {
  const name = filename.replace(/\.[^.]+$/, '');
  return name.toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildMap(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => d.name)
    .sort();

  const map = {};
  for (const f of entries) {
    const id = slugName(f);
    const posixPath = path.posix.join(dirPath.replace(/\\/g,'/'), f);
    map[id] = posixPath;
  }
  return map;
}

function formatMap(map) {
  const lines = Object.keys(map).sort().map(k => `  '${k}': '${map[k]}'`);
  return 'const PHOTO_MAP = {\n' + lines.join(',\n') + '\n};';
}

function injectIntoFile(filePath, newSnippet) {
  const full = fs.readFileSync(filePath, 'utf8');
  const re = /const\s+PHOTO_MAP\s*=\s*{[\s\S]*?};/m;
  if (!re.test(full)) {
    console.error(`${filePath}: existing PHOTO_MAP block not found.`);
    return false;
  }
  const updated = full.replace(re, newSnippet);
  if (write) fs.writeFileSync(filePath, updated, 'utf8');
  return true;
}

try {
  const map = buildMap(dir);
  const snippet = formatMap(map);

  console.log('Generated PHOTO_MAP with', Object.keys(map).length, 'entries.');

  for (const f of files) {
    const p = path.resolve(f);
    const ok = injectIntoFile(p, snippet);
    console.log(`${f}: ${ok ? (write ? 'updated' : 'would update') : 'no change'}`);
  }
  if (!write) console.log('Run with --write to apply changes.');
} catch (err) {
  console.error('Error:', err.message);
  process.exit(2);
}
