// Git helpers for the review hook. A review covers what changed between two snapshots of the
// working tree, committed or not, so it works with or without a remote. The hook remembers the
// last snapshot it reviewed for each folder and branch.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATE_DIR } from './herdr.mjs';

// .team/ holds the minions' record, not the project's work, so no review covers it.
export const NOT_REVIEWED = ['.', ':(exclude).team'];
// Git's tree with no files: the base of a review that covers everything.
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();

// The top folder of the git checkout that holds dir, or null when dir is not in one.
export function gitRoot(dir) {
  try { return git(dir, 'rev-parse', '--show-toplevel'); } catch { return null; }
}

// The branch checked out, or "HEAD" when no branch is.
export function currentBranch(root) {
  try { return git(root, 'symbolic-ref', '--short', '-q', 'HEAD'); } catch { return 'HEAD'; }
}

// The working tree as a git tree: tracked and new files, not ignored ones. It is built in a
// temporary index, so the project's own index never changes. The tree's ID is a hash of the
// content, so the same work always gives the same ID.
export function snapshot(root) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-snapshot-'));
  try {
    const index = join(dir, 'index');
    const own = git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    // A copy of the real index keeps git's cache of file times, so unchanged files are not read.
    if (existsSync(own)) copyFileSync(own, index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    execFileSync('git', ['-C', root, 'add', '-A'], { env, stdio: 'ignore' });
    return execFileSync('git', ['-C', root, 'write-tree'], { env, encoding: 'utf8' }).trim();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Whether anything outside .team/ differs between two trees or commits.
export function changedBetween(root, base, tree) {
  const diff = spawnSync('git', ['-C', root, 'diff', '--quiet', base, tree, '--', ...NOT_REVIEWED], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (diff.status === 0 || diff.status === 1) return diff.status === 1;
  throw new Error(`git diff failed in ${root}: ${(diff.stderr || diff.error?.message || '').trim()}`);
}

// Where the first review of a branch starts, the first rule that applies:
// 1. where the branch left the remote's default branch (origin/HEAD, origin/main, origin/master);
// 2. where it left the local main or master, when it is another branch;
// 3. on the default branch with no remote, the commit before the last one: the last commit and
//    any work not committed are reviewed;
// 4. with one commit or none, the empty tree: everything is reviewed.
export function firstBase(root, branch = currentBranch(root)) {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    if (ref === branch) continue;
    try { return git(root, 'merge-base', 'HEAD', ref); } catch { /* no such ref */ }
  }
  try { return git(root, 'rev-parse', '--verify', '-q', 'HEAD~1'); } catch { return EMPTY_TREE; }
}

const real = (dir) => { try { return realpathSync(dir); } catch { return dir; } };
const markFile = (root, branch) => join(STATE_DIR, 'reviewed', `${createHash('sha1').update(`${real(root)}|${branch}`).digest('hex')}.json`);

// The snapshot the last finished review of this folder and branch covered, or null. Git prunes
// a snapshot nothing points to after about two weeks; then there is none.
export function lastReviewed(root, branch = currentBranch(root)) {
  try {
    const { tree } = JSON.parse(readFileSync(markFile(root, branch), 'utf8'));
    git(root, 'cat-file', '-e', tree);
    return tree;
  } catch { return null; }
}

// Records that a review covered this snapshot. The next review starts from it.
export function markReviewed(root, tree = snapshot(root), branch = currentBranch(root)) {
  const file = markFile(root, branch);
  mkdirSync(join(STATE_DIR, 'reviewed'), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ root: real(root), branch, tree, at: new Date().toISOString() })}\n`);
}

// Where the next review starts: the last review, or else the branch's first review base.
export const reviewBase = (root, branch = currentBranch(root)) => lastReviewed(root, branch) ?? firstBase(root, branch);
