#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);

function runGit(gitArgs) {
  return execFileSync('git', gitArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function parseMode(argv) {
  if (argv.includes('--staged')) {
    return { type: 'staged' };
  }

  const rangeIdx = argv.indexOf('--range');
  if (rangeIdx >= 0 && argv[rangeIdx + 1]) {
    return { type: 'range', value: argv[rangeIdx + 1] };
  }

  return { type: 'staged' };
}

function getDiff(mode) {
  if (mode.type === 'staged') {
    return runGit(['diff', '--cached', '--unified=0', '--no-color']);
  }

  return runGit(['diff', '--unified=0', '--no-color', mode.value]);
}

function shouldSkipFile(filePath) {
  if (!filePath) return true;
  if (filePath.includes('/node_modules/') || filePath.startsWith('node_modules/')) return true;
  if (filePath.includes('/dist/') || filePath.startsWith('dist/')) return true;
  if (filePath.includes('/build/') || filePath.startsWith('build/')) return true;
  if (filePath.startsWith('.git/')) return true;
  return false;
}

function normalizeValue(raw) {
  return raw.replace(/^['"`]|['"`]$/g, '').trim();
}

function isLikelyPlaceholder(value) {
  const v = normalizeValue(value);
  if (!v) return true;

  if (v.startsWith('<') && v.endsWith('>')) return true;
  if (v.startsWith('$') || v.includes('${')) return true;
  if (v === '0x...' || v.includes('...')) return true;

  const lower = v.toLowerCase();
  if (lower.includes('example') || lower.includes('placeholder') || lower.includes('changeme')) return true;
  if (lower.startsWith('replace-with-') || lower.startsWith('your_')) return true;
  if (lower.includes('process.env') || lower.includes('import.meta.env')) return true;
  if (lower.startsWith('http://') || lower.startsWith('https://')) return true;
  if (lower.includes('localhost')) return true;
  if (lower.includes('mock') || lower.includes('dummy')) return true;
  if (lower.startsWith('test-') || lower.startsWith('test_')) return true;

  return false;
}

function looksLikeRealSecret(value) {
  const v = normalizeValue(value);
  if (isLikelyPlaceholder(v)) return false;
  if (v.length < 20) return false;
  if (!/[A-Za-z]/.test(v)) return false;
  if (!/[0-9]/.test(v)) return false;
  return true;
}

function findLineIssues(filePath, lineNo, line) {
  const findings = [];

  const privateKeyRe = /(?:PRIVATE_KEY|privateKey|WALLET_KEY|walletKey)\s*[:=]\s*['"]?(0x[a-fA-F0-9]{64})['"]?/g;
  for (const match of line.matchAll(privateKeyRe)) {
    const value = match[1];
    if (isLikelyPlaceholder(value)) continue;
    findings.push({ filePath, lineNo, kind: 'private-key-literal', snippet: value.slice(0, 14) + '...' });
  }

  const bearerRe = /Authorization[^\n]*Bearer\s+([A-Za-z0-9._-]{20,})/g;
  for (const match of line.matchAll(bearerRe)) {
    const value = match[1];
    if (!looksLikeRealSecret(value)) continue;
    findings.push({ filePath, lineNo, kind: 'bearer-literal', snippet: value.slice(0, 14) + '...' });
  }

  const sensitiveAssignRe = /(?:^|\s)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|apiKey|token|secret|password|privateKey|accessKey)[A-Za-z0-9_]*)\s*[:=]\s*(['"`]?)([^'"`\s]+)\2/g;
  for (const match of line.matchAll(sensitiveAssignRe)) {
    const value = match[3];
    if (!looksLikeRealSecret(value)) continue;
    findings.push({
      filePath,
      lineNo,
      kind: `sensitive-assignment:${match[1]}`,
      snippet: normalizeValue(value).slice(0, 14) + '...',
    });
  }

  return findings;
}

function parseAddedLines(diffText) {
  const findings = [];
  let filePath = '';
  let newLineNo = 0;

  const lines = diffText.split('\n');
  for (const rawLine of lines) {
    const line = rawLine;

    if (line.startsWith('+++ b/')) {
      filePath = line.slice('+++ b/'.length);
      continue;
    }

    if (line.startsWith('@@')) {
      const hunkMatch = line.match(/\+(\d+)(?:,(\d+))?/);
      if (hunkMatch) {
        newLineNo = Number(hunkMatch[1]) - 1;
      }
      continue;
    }

    if (!filePath || shouldSkipFile(filePath)) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      newLineNo += 1;
      const added = line.slice(1);
      findings.push(...findLineIssues(filePath, newLineNo, added));
      continue;
    }

    if (line.startsWith(' ') || line.startsWith('\\')) {
      newLineNo += 1;
    }
  }

  const dedup = new Map();
  for (const finding of findings) {
    const key = `${finding.filePath}:${finding.lineNo}:${finding.kind}:${finding.snippet}`;
    dedup.set(key, finding);
  }
  return [...dedup.values()];
}

const mode = parseMode(args);
const diffText = getDiff(mode);
const findings = parseAddedLines(diffText);

if (findings.length === 0) {
  process.exit(0);
}

console.error('Secret guard blocked this change: literal secret-like values detected in added lines.');
for (const finding of findings) {
  console.error(`- ${finding.filePath}:${finding.lineNo} [${finding.kind}] ${finding.snippet}`);
}
console.error('Use placeholders in tracked files and keep real values in .git-secrets-map.local.json.');
process.exit(1);
