#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (mode !== 'clean' && mode !== 'smudge') {
  console.error('Usage: node scripts/secret-filter.mjs <clean|smudge>');
  process.exit(2);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const localMapPath = path.join(repoRoot, '.git-secrets-map.local.json');

function normalizeKey(key) {
  return key.replace(/^<|>$/g, '').trim();
}

function loadSecretMap() {
  if (!fs.existsSync(localMapPath)) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(localMapPath, 'utf8'));
  } catch (error) {
    console.error(`Invalid JSON in ${localMapPath}: ${error.message}`);
    process.exit(1);
  }

  const source = parsed && typeof parsed === 'object' && parsed.secrets && typeof parsed.secrets === 'object'
    ? parsed.secrets
    : parsed;

  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(source || {})) {
    if (typeof rawValue !== 'string') continue;
    const key = normalizeKey(rawKey);
    const value = rawValue.trim();
    if (!key || !value || value.startsWith('replace-with-your-')) {
      continue;
    }
    normalized[key] = value;
  }

  return normalized;
}

function applyReplacements(content, entries, direction) {
  let output = content;
  const sorted = [...entries].sort((a, b) => b[1].length - a[1].length);

  for (const [key, value] of sorted) {
    if (!value) continue;
    const placeholder = `<${key}>`;
    if (direction === 'clean') {
      output = output.split(value).join(placeholder);
    } else {
      output = output.split(placeholder).join(value);
    }
  }

  return output;
}

const input = fs.readFileSync(0, 'utf8');
const secretMap = loadSecretMap();
const entries = Object.entries(secretMap);

if (entries.length === 0) {
  process.stdout.write(input);
  process.exit(0);
}

const output = applyReplacements(input, entries, mode);
process.stdout.write(output);
