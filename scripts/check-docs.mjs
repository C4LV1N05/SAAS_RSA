#!/usr/bin/env node
/**
 * Keeps the docs honest as the code moves: every repository path named in
 * backticks in the docs must exist, and every Mermaid block must declare a
 * known diagram type with balanced brackets. Runs in CI (`pnpm docs:check`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = ['README.md', 'docs/ARCHITECTURE.md', 'docs/SERVE.md', 'docs/DEPLOY_AZURE.md'];
const roots = ['apps/', 'packages/', 'db/', 'infra/', 'docs/', 'scripts/', '.github/'];
// Build outputs are named in the docs but only exist after a build.
const generated = /(^|\/)(dist|node_modules|\.media)(\/|$)/;
const diagramTypes = ['flowchart', 'sequenceDiagram', 'erDiagram', 'classDiagram', 'stateDiagram-v2', 'graph'];

const problems = [];
for (const doc of docs) {
  const text = readFileSync(join(root, doc), 'utf8');

  for (const [, token] of text.matchAll(/`([^`\s]+)`/g)) {
    if (!roots.some((r) => token.startsWith(r)) || generated.test(token)) continue;
    const path = token.replace(/[),.:;]+$/, '').replace(/\*.*$/, '');
    if (!existsSync(join(root, path))) problems.push(`${doc}: \`${token}\` does not exist`);
  }

  let n = 0;
  for (const [, body] of text.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
    n += 1;
    const first = body.trim().split('\n')[0].trim().split(/\s/)[0];
    if (!diagramTypes.includes(first)) problems.push(`${doc}: Mermaid block ${n} starts with "${first}"`);
    // erDiagram cardinality markers (||--o{) use braces on their own.
    const pairs = first === 'erDiagram' ? [['[', ']'], ['(', ')']] : [['[', ']'], ['(', ')'], ['{', '}']];
    for (const [open, close] of pairs) {
      const count = (c) => body.split(c).length - 1;
      if (count(open) !== count(close)) problems.push(`${doc}: Mermaid block ${n} has unbalanced ${open}${close}`);
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`docs ok: ${docs.length} files checked`);
