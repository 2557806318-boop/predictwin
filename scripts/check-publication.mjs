import { execFileSync } from 'node:child_process';

// Only explicit source/documentation paths are publishable. No binary exceptions.
const rootFiles = new Set(['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'package.json', '.gitignore', '.env.example', '.dockerignore']);
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.length) throw new Error('Stage the reviewed publication files before checking');
const violations = [];
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['cloud access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['messaging token', /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/],
  ['embedded URL password', /https?:\/\/[^\s/@]+:[^\s/@]+@/],
  ['personal Windows path', /[A-Za-z]:[\\/]Users[\\/][^\s/\\]+/],
  ['wallet private key', /\b(?:0x)?[0-9a-fA-F]{64}\b/],
  ['secret assignment', /(?:api[_-]?key|api[_-]?secret|password|bot[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_+\/-]{12,}["']/i],
];
for (const file of files) {
  if (!rootFiles.has(file) && !/^(?:src|tests|examples|scripts)\/[a-z0-9-]+(?:\.test)?\.mjs$/.test(file) &&
      !/^docs\/[A-Z]+\.md$/.test(file) && !/^docs\/images\/[a-z-]+\.svg$/.test(file) &&
      file !== 'web/index.html' && file !== '.github/workflows/ci.yml') violations.push(`${file}: path not allowlisted`);
  // Inspect the INDEX that will be committed, not a possibly different worktree.
  const content = execFileSync('git', ['show', `:${file}`], { maxBuffer: 1_000_000 });
  if (content.length > 100_000 || content.includes(0)) violations.push(`${file}: large or binary content`);
  const text = content.toString('utf8');
  for (const [name, regex] of patterns) if (regex.test(text)) violations.push(`${file}: ${name}`);
  for (const address of text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []) {
    if (address !== '127.0.0.1') violations.push(`${file}: non-loopback IP address`);
  }
}
if (violations.length) {
  // Never print the matched secret itself.
  console.error(violations.join('\n')); process.exitCode = 1;
} else console.log(`PASS: ${files.length} tracked text files; allowlist and common-secret checks passed. Manual review still required.`);
