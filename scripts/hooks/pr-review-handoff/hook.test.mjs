// Run: node --test scripts/hooks/pr-review-handoff/hook.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { agentName, commandDir, createResult, heredocsOpened, sameBranch, withoutHeredocs, fixPrompt, headBranch, isPrCreate, isReviewerPane, recentStarts, ownReviewerPane, repoOf, reviewerTool, reviewPrompt, splitDirection } from './hook.mjs';

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('isPrCreate matches gh pr create only', () => {
  assert.equal(isPrCreate(bash('gh pr create --draft --title "x" --body "y"')), true);
  assert.equal(isPrCreate(bash('git push -u origin feat && gh pr create --fill')), true);
  assert.equal(isPrCreate({ tool_name: 'Shell', tool_input: { command: 'gh pr create' } }), true);
  assert.equal(isPrCreate(bash('gh pr edit 4 --title x')), false);
  assert.equal(isPrCreate(bash('cd repo && gh pr create --fill')), true);
  assert.equal(isPrCreate(bash('git push\ngh pr create --fill')), true);
  assert.equal(isPrCreate(bash('gh pr view 4')), false);
  assert.equal(isPrCreate(bash('echo "then run gh pr create" > notes.md')), false);
  assert.equal(isPrCreate(bash("python3 - <<'PY'\n# After an agent runs \"gh pr create\" here\nPY")), false);
  // Inside a heredoc, even text that looks like a command chain is only text.
  assert.equal(isPrCreate(bash("python3 - <<'PY'\nnote = 'gh pr view 3 && gh pr create'\nPY")), false);
  assert.equal(isPrCreate(bash("cat > a.md <<EOF\nrun:\ngh pr create --fill\nEOF\ngit add a.md")), false);
  // A real create next to a heredoc still counts, and so does a body passed with a heredoc.
  assert.equal(isPrCreate(bash("cat > b.md <<'EOF'\ntext\nEOF\ngh pr create --body-file b.md")), true);
  assert.equal(isPrCreate(bash("gh pr create --title T --body-file - <<'EOF'\nBody && gh pr view 2\nEOF")), true);
  // One line can open two heredocs: both bodies are text.
  assert.equal(isPrCreate(bash('cat <<A <<B\nfirst\nA\n&& gh pr create\nB')), false);
  assert.equal(isPrCreate(bash("cat <<-'X'\n\tgh pr create\n\tX\necho done")), false);
  // A here-string is not a heredoc, so the command after it still counts.
  assert.equal(isPrCreate(bash('cat <<<"hello" && gh pr create --fill')), true);
  assert.equal(isPrCreate({ tool_name: 'Write', tool_input: { command: 'gh pr create' } }), false);
  assert.equal(isPrCreate({}), false);
});

test('commandDir follows a leading cd', () => {
  assert.equal(commandDir('gh pr create', '/repo'), '/repo');
  assert.equal(commandDir('cd sub && gh pr create', '/repo'), '/repo/sub');
  assert.equal(commandDir('cd "/other place" && gh pr create', '/repo'), '/other place');
  assert.equal(commandDir('cd ~/code && gh pr create', '/repo'), `${homedir()}/code`);
  // A cd after the PR command does not change where the PR was made.
  assert.equal(commandDir('cd a && gh pr create --fill && cd ../other', '/repo'), '/repo/a');
  // Each cd starts from the one before it.
  assert.equal(commandDir('cd service && cd app && gh pr create', '/repo'), '/repo/service/app');
  assert.equal(commandDir('cd service && cd /abs && cd app && gh pr create', '/repo'), '/abs/app');
});

test('createResult reads the new PR URL, and sees a create that failed', () => {
  const ok = createResult({ tool_response: { stdout: 'https://github.com/o/r/pull/9\n', stderr: '' } });
  assert.deepEqual(ok, { failed: false, url: 'https://github.com/o/r/pull/9' });
  const exists = createResult({ tool_response: { stderr: 'a pull request for branch "x" into branch "main" already exists:\nhttps://github.com/o/r/pull/4' } });
  assert.equal(exists.failed, true);
  assert.equal(createResult({ tool_response: 'https://github.com/o/r/pull/12' }).url, 'https://github.com/o/r/pull/12');
  assert.deepEqual(createResult({}), { failed: false, url: null });
  // Another PR's URL in the same output: ambiguous, so no URL is trusted.
  const two = createResult({ tool_response: { stdout: 'title: Old\nurl: https://github.com/o/r/pull/3\nhttps://github.com/o/r/pull/9\n' } });
  assert.equal(two.url, null);
  // The same URL twice is still one PR.
  assert.equal(createResult({ tool_response: 'https://github.com/o/r/pull/9 https://github.com/o/r/pull/9' }).url, 'https://github.com/o/r/pull/9');
});

test('sameBranch checks the PR is on the branch the command made it for', () => {
  assert.equal(sameBranch('feat/x', 'feat/x'), true);
  assert.equal(sameBranch('octo:feat/x', 'feat/x'), true);
  assert.equal(sameBranch('feat/x', 'main'), false);
  // Unknown branch (not a git folder): nothing to compare.
  assert.equal(sameBranch(null, 'feat/x'), true);
});

test('repoOf gives owner/repo, so each repository gets its own reviewer', () => {
  assert.equal(repoOf('https://github.com/octo/demo/pull/14'), 'octo/demo');
  assert.notEqual(repoOf('https://github.com/o/a/pull/1'), repoOf('https://github.com/o/b/pull/1'));
});

test('headBranch reads --head and -H', () => {
  assert.equal(headBranch('gh pr create --fill'), null);
  assert.equal(headBranch('gh pr create --head feat/x --fill'), 'feat/x');
  assert.equal(headBranch('gh pr create --head=feat/x'), 'feat/x');
  assert.equal(headBranch('gh pr create -H "feat/y" --fill'), 'feat/y');
});

test('reviewerTool picks the other tool unless PR_REVIEWER chooses', () => {
  assert.equal(reviewerTool('claude'), 'codex');
  assert.equal(reviewerTool('codex'), 'claude');
  assert.equal(reviewerTool('claude', { PR_REVIEWER: 'claude' }), 'claude');
  assert.equal(reviewerTool('codex', { PR_REVIEWER: 'nonsense' }), 'claude');
});

test('agentName is a valid, unique Herdr name', () => {
  const name = agentName('codex', 'wW:p3');
  assert.equal(name, 'review-codex-ww-p3');
  assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.notEqual(agentName('codex', 'wW:p3'), agentName('codex', 'wW:p4'));
  assert.ok(agentName('claude', 'w123456789:p123456789').length <= 32);
});

test('splitDirection splits wide panes right and tall panes down', () => {
  assert.equal(splitDirection({ width: 123, height: 33 }), 'right');
  assert.equal(splitDirection({ width: 60, height: 40 }), 'down');
  assert.equal(splitDirection(undefined), 'down');
});

test('ownReviewerPane reuses only a pane with the hook label, in the same workspace', () => {
  const pane = (over) => ({ pane_id: 'wV:p2', workspace_id: 'wV', label: 'codex review', agent: 'codex', ...over });
  assert.equal(ownReviewerPane(pane(), 'wV', 'codex'), 'reuse');
  assert.equal(ownReviewerPane(pane({ agent: null }), 'wV', 'codex'), 'restart');
  // The user's own Codex pane: same ID after a restart, but not our label.
  assert.equal(ownReviewerPane(pane({ label: null }), 'wV', 'codex'), null);
  assert.equal(ownReviewerPane(pane({ label: 'v3-codex' }), 'wV', 'codex'), null);
  assert.equal(ownReviewerPane(pane({ agent: 'claude' }), 'wV', 'codex'), null);
  assert.equal(ownReviewerPane(pane({ workspace_id: 'wW' }), 'wV', 'codex'), null);
  assert.equal(ownReviewerPane(null, 'wV', 'codex'), null);
});

test('reviewPrompt names the PR and forbids edits', () => {
  const text = reviewPrompt({ url: 'https://github.com/o/r/pull/7', number: 7 });
  assert.match(text, /pull\/7/);
  assert.match(text, /gh pr diff https:\/\/github.com\/o\/r\/pull\/7/);
  assert.match(text, /gh pr review https:\/\/github.com\/o\/r\/pull\/7 --comment/);
  assert.match(text, /Do not edit/);
  assert.doesNotMatch(text, /\n/);
});

test('fixPrompt asks the builder to fix, push and reply with each finding', () => {
  const text = fixPrompt({ url: 'https://github.com/o/r/pull/7', number: 7 }, 'https://github.com/o/r/pull/7#pullrequestreview-1', 'codex');
  assert.match(text, /^codex reviewed your pull request https:\/\/github.com\/o\/r\/pull\/7/);
  assert.match(text, /pullrequestreview-1/);
  assert.match(text, /gh pr comment https:\/\/github.com\/o\/r\/pull\/7 --body-file/);
  assert.match(text, /not fixed" with the reason/);
  assert.doesNotMatch(text, /\n/);
});

test('isReviewerPane stops a reviewer pane from starting another review', () => {
  const saved = { '/s.sock|wV|o/r|codex': 'wV:p2', '/other.sock|wV|o/r|codex': 'wV:p5' };
  assert.equal(isReviewerPane(saved, '/s.sock', { pane_id: 'wV:p2', label: 'codex review' }), true);
  // A builder pane, and a reviewer pane of another server, are not reviewers here.
  assert.equal(isReviewerPane(saved, '/s.sock', { pane_id: 'wV:p1', label: 'claude build' }), false);
  assert.equal(isReviewerPane(saved, '/s.sock', { pane_id: 'wV:p5', label: 'codex review' }), false);
  // After a restart the ID may belong to a user's pane: no hook label, so not a reviewer.
  assert.equal(isReviewerPane(saved, '/s.sock', { pane_id: 'wV:p2', label: 'my notes' }), false);
  assert.equal(isReviewerPane(saved, '/s.sock', null), false);
});

test('recentStarts keeps only the last hour', () => {
  const now = 10 * 3_600_000;
  assert.deepEqual(recentStarts([now - 3_700_000, now - 1_000, now - 60_000], now), [now - 1_000, now - 60_000]);
  assert.deepEqual(recentStarts(undefined, now), []);
});

test('takeReviewSlot keeps the hourly limit when workers run at the same time', async () => {
  const state = mkdtempSync(join(tmpdir(), 'prh-slot-'));
  const hook = new URL('./hook.mjs', import.meta.url).href;
  // 6 workers for 6 different PRs from one builder pane start together; the limit is 3.
  const run = (n) => new Promise((done) => {
    const code = `import(${JSON.stringify(hook)}).then(async (m) => process.stdout.write(await m.takeReviewSlot('/s.sock|wV:p1', 'https://github.com/o/r/pull/${n}', 3, 300)))`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, PR_HANDOFF_STATE_DIR: state } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => done(out));
  });
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(run));
  assert.equal(results.filter((r) => r === 'ok').length, 3);
  assert.equal(results.filter((r) => r === 'paused').length, 3);
  // All 3 start times are kept: no write wiped another.
  const [file] = readdirSync(join(state, 'review-starts'));
  assert.equal(JSON.parse(readFileSync(join(state, 'review-starts', file), 'utf8')).length, 3);
});

test('withoutHeredocs keeps the command lines and drops each body', () => {
  assert.equal(withoutHeredocs("cat <<A <<'B'\none\nA\ntwo\nB\ngh pr create"), "cat <<A <<'B'\ngh pr create");
  assert.equal(withoutHeredocs('git push && gh pr create --fill'), 'git push && gh pr create --fill');
});

test('heredocsOpened reads full delimiter words and skips what is not a heredoc', () => {
  assert.deepEqual(heredocsOpened("cat <<'EOF'"), [{ word: 'EOF', tabs: false }]);
  assert.deepEqual(heredocsOpened('cat <<END-OF'), [{ word: 'END-OF', tabs: false }]);
  assert.deepEqual(heredocsOpened('cat <<-"A B" <<\\C'), [{ word: 'A B', tabs: true }, { word: 'C', tabs: false }]);
  assert.deepEqual(heredocsOpened('gh pr create --body "$(cat <<\'EOF\'"'), [{ word: 'EOF', tabs: false }]);
  // Not heredocs: a shift in arithmetic, text in quotes, a here-string.
  assert.deepEqual(heredocsOpened('echo $((1 << 2)) && (( x <<= 1 ))'), []);
  assert.deepEqual(heredocsOpened('echo "a << b" \'c << d\''), []);
  assert.deepEqual(heredocsOpened('cat <<<"hello"'), []);
});

test('withoutHeredocs ends a body only at its exact closing line', () => {
  const bash = (command) => isPrCreate({ tool_name: 'Bash', tool_input: { command } });
  // A shift or a quoted "<<" does not hide the real command after it.
  assert.equal(bash('echo $((1 << 2))\ngh pr create --fill'), true);
  assert.equal(bash('echo "x << y"\ngh pr create --fill'), true);
  // A delimiter with punctuation is read in full.
  assert.equal(bash('cat <<END-OF\n&& gh pr create\nEND-OF'), false);
  assert.equal(bash('cat <<END-OF\nbody\nEND-OF\ngh pr create'), true);
  // For "<<", a line with a space before EOF does not end the body.
  assert.equal(bash('cat <<EOF\n EOF\n&& gh pr create\nEOF'), false);
  // For "<<-", leading tabs (only tabs) are stripped from the closing line.
  assert.equal(bash('cat <<-EOF\n\tbody\n\tEOF\ngh pr create'), true);
  assert.equal(bash('cat <<-EOF\n  EOF\n&& gh pr create\nEOF'), false);
  // The usual way to pass a PR body.
  assert.equal(bash("gh pr create --title T --body \"$(cat <<'EOF'\nBody && gh pr view 2\nEOF\n)\""), true);
  assert.equal(withoutHeredocs("gh pr create --body \"$(cat <<'EOF'\nBody\nEOF\n)\""), "gh pr create --body \"$(cat <<'EOF'\n)\"");
});
