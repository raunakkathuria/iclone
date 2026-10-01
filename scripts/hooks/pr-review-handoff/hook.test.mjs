// Run: node --test scripts/hooks/pr-review-handoff/hook.test.mjs
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { agentName, commandDir, fixPrompt, headBranch, isPrCreate, ownReviewerPane, repoOf, reviewerTool, reviewPrompt, splitDirection } from './hook.mjs';

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
