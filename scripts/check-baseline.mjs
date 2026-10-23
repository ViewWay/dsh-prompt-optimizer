#!/usr/bin/env node
// Baseline coherence gate. docs/compatibility.md is the contractual source of
// truth for the @deepseek-ai/dsh-* baseline; this script fails when the CI
// clone tag or any workspace package.json entry drifts from it.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const rel = (file) => path.relative(root, file).split(path.sep).join('/');

// docs/compatibility.md baseline table row: | `@deepseek-ai/dsh-*` | `<version>` | ... |
const BASELINE_ROW = /^\|\s*`@deepseek-ai\/dsh-\*`\s*\|\s*`([^`\s]+)`\s*\|/m;
// ci.yml harness clone: git clone --depth 1 --branch dsh-v<version> ...
const CI_TAG = /--branch\s+dsh-v(\S+)/;
// Any version-pinned @deepseek-ai/dsh-* entry in a package.json dependency section.
const DSH_ENTRY = /"(@deepseek-ai\/dsh-[^"]+)"\s*:\s*"([^"]*)"/g;

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    problems.push(`${rel(file)}: cannot read (${err.message})`);
    return '';
  }
}

function parseBaseline() {
  const compat = path.join(root, 'docs', 'compatibility.md');
  const match = readText(compat).match(BASELINE_ROW);
  if (!match) {
    problems.push(
      `${rel(compat)}: baseline row "| \`@deepseek-ai/dsh-*\` | \`<version>\` |" not found`,
    );
    return null;
  }
  return match[1];
}

function checkCiTag(baseline) {
  const ci = path.join(root, '.github', 'workflows', 'ci.yml');
  const lines = readText(ci).split(/\r?\n/);
  let tags = 0;
  lines.forEach((line, index) => {
    const match = line.match(CI_TAG);
    if (!match) return;
    tags += 1;
    if (match[1] !== baseline) {
      problems.push(
        `${rel(ci)}:${index + 1}: clone tag "dsh-v${match[1]}" != baseline (expected "dsh-v${baseline}")`,
      );
    }
  });
  if (tags === 0) {
    problems.push(`${rel(ci)}: no "clone --branch dsh-v<baseline>" tag found`);
  }
  return tags;
}

function workspacePackageFiles() {
  const files = [path.join(root, 'package.json')];
  const packagesDir = path.join(root, 'packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const file = path.join(packagesDir, entry.name, 'package.json');
        if (existsSync(file)) files.push(file);
      }
    }
  }
  return files;
}

function checkPackages(baseline) {
  let entries = 0;
  for (const file of workspacePackageFiles()) {
    const text = readText(file);
    for (const match of text.matchAll(DSH_ENTRY)) {
      entries += 1;
      if (match[2] !== baseline) {
        const line = text.slice(0, match.index).split('\n').length;
        problems.push(
          `${rel(file)}:${line}: ${match[1]} expected "${baseline}", got "${match[2]}"`,
        );
      }
    }
  }
  return entries;
}

const baseline = parseBaseline();
let checkedEntries = 0;
if (baseline !== null) {
  const tags = checkCiTag(baseline);
  checkedEntries = tags + checkPackages(baseline);
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`baseline check failed: ${problem}`);
  }
  process.exit(1);
}

console.log(
  `baseline ok: @deepseek-ai/dsh-* ${baseline} consistent across docs/compatibility.md, ci.yml clone tag and workspace package.json (${checkedEntries} checks)`,
);
