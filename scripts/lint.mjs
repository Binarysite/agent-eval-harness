// Dependency-free lint: every .js/.mjs file must parse (node --check) and have no
// tabs or trailing whitespace. Text files get the whitespace check only.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const DIRS = ['bin', 'src', 'test', 'examples', 'scripts', 'docs', '.github'];
const TEXT = new Set(['.js', '.mjs', '.json', '.md', '.yml']);

const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const files = [...DIRS.filter(existsSync).flatMap(walk), 'README.md', 'package.json', 'action.yml', 'CHANGELOG.md']
  .filter((f) => TEXT.has(extname(f)));

const problems = [];
for (const file of files) {
  if (['.js', '.mjs'].includes(extname(file))) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      problems.push(`${file}: ${String(err.stderr).trim()}`);
    }
  }
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (/\t/.test(line)) problems.push(`${file}:${i + 1}: tab`);
    if (/[ \t]+$/.test(line)) problems.push(`${file}:${i + 1}: trailing whitespace`);
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`lint: ${files.length} files OK`);
