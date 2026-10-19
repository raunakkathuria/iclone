#!/usr/bin/env node
// team-up [project folder]: starts the minion team for a project in Herdr.
//
// 1. Creates .team/ from the templates. It never overwrites a file that is there. A new
//    LESSONS.md also gets every lesson in the global list, from team promote.
// 2. Stops while .team/GOAL.md is still the template: Gru writes the goal first.
// 3. Opens a workspace named "<project> minions". The layout code (ensureLayout in
//    lib/herdr.mjs, also run by the Herdr plugin) fills it with four minions, each with its role.
// 4. Sends the first prompts: product-minion and reviewer-minion check the goal, and the other
//    two wait for work.
// When the team is already running, it only shows the workspace again.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINIONS, ensureLayout, herdr, roleNote, sendPrompt, sleep, teamLabel, waitReady } from '../lib/herdr.mjs';
import { LIMIT, PROMOTED, addLesson, promotedBodies } from './lessons.mjs';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), 'templates');
const KICKOFF = {
  reviewer: 'Gru wrote the goal in .team/GOAL.md. Do your goal check now, as your role says.',
  product: 'Gru wrote the goal in .team/GOAL.md. Do your goal check now, as your role says. When both checks are written, escalate or write the board.',
  builder: 'Read .team/GOAL.md and .team/LESSONS.md. Then wait until product-minion says the board is ready.',
  qa: 'Read .team/GOAL.md. Then wait for a handover from builder-minion.',
};

function gitRoot(dir) {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

// A new project's LESSONS.md: the template, with each lesson in the global list as L-1, L-2 and so
// on, in the list's order. A missing or broken list adds none.
function newLessons() {
  const bodies = promotedBodies(existsSync(PROMOTED) ? readFileSync(PROMOTED, 'utf8') : '');
  if (bodies.length > LIMIT) throw new Error(`${PROMOTED} has ${bodies.length} lessons, more than ${LIMIT}. Merge two lessons or drop one, then run team-up again.`);
  return bodies.reduce((text, body) => addLesson(text, body).text, readFileSync(join(TEMPLATES, 'LESSONS.md'), 'utf8'));
}

// Creates what is missing in .team/. Returns true when GOAL.md still needs Gru.
function scaffold(root) {
  const team = join(root, '.team');
  // Built before anything is written, so a bad global list leaves .team/ as it was.
  const lessons = existsSync(join(team, 'LESSONS.md')) ? null : newLessons();
  for (const dir of ['gate', 'handoffs', 'qa']) mkdirSync(join(team, dir), { recursive: true });
  for (const name of readdirSync(TEMPLATES)) {
    if (existsSync(join(team, name))) continue;
    if (name === 'LESSONS.md') writeFileSync(join(team, name), lessons);
    else copyFileSync(join(TEMPLATES, name), join(team, name));
  }
  if (!existsSync(join(team, '.gitignore'))) writeFileSync(join(team, '.gitignore'), 'LOG.md\n');
  return readFileSync(join(team, 'GOAL.md'), 'utf8') === readFileSync(join(TEMPLATES, 'GOAL.md'), 'utf8');
}

// Waits until every minion pane has a tool running. The plugin may be building the same
// workspace; ensureLayout then returns null, and this tries again.
async function layout(ws) {
  for (let i = 0; i < 60; i++) {
    const panes = await ensureLayout(ws);
    const running = new Set(herdr('pane', 'list', '--workspace', ws).panes.filter((p) => p.agent).map((p) => p.pane_id));
    if (panes?.qa && Object.keys(MINIONS).every((role) => running.has(panes[role]))) return panes;
    await sleep(3000);
  }
  throw new Error(`the minions in workspace ${ws} did not all start. Look at the panes for a question to answer.`);
}

// Sends a minion its first prompt. A new tool can wait at a question first, such as "Do you trust
// this folder?"; then Gru answers it in the pane, and this waits.
async function kickoff(pane, role, text) {
  const { agent: kind, agent_status: status } = herdr('agent', 'get', pane).agent;
  if (status === 'blocked') console.log(`${MINIONS[role]} waits at a question in pane ${pane}. Answer it there.`);
  try {
    return (await waitReady(pane, MINIONS[role], 30 * 60_000)) && (await sendPrompt(pane, roleNote(role, kind) + text));
  } catch (e) {
    if (e.code === 'agent_blocked') return false;
    throw e;
  }
}

async function main() {
  const root = resolve(process.argv[2] ?? gitRoot(process.cwd()) ?? process.cwd());
  if (scaffold(root)) {
    console.log(`Created ${join(root, '.team')}. Write the goal in .team/GOAL.md, then run team-up again.`);
    return;
  }
  const label = teamLabel(root);
  const running = herdr('workspace', 'list').workspaces.find((w) => w.label === label);
  if (running) {
    await layout(running.workspace_id);
    herdr('workspace', 'focus', running.workspace_id);
    console.log(`The minions of ${label} are already running, in workspace ${running.workspace_id}.`);
    return;
  }
  const ws = herdr('workspace', 'create', '--cwd', root, '--label', label, '--no-focus').workspace.workspace_id;
  console.log(`Starting the minions in workspace ${ws}. This takes about a minute.`);
  const panes = await layout(ws);
  for (const [role, text] of Object.entries(KICKOFF)) {
    if (!(await kickoff(panes[role], role, text))) console.error(`team-up: ${MINIONS[role]} did not take its first prompt. Send it yourself: ${text}`);
  }
  herdr('workspace', 'focus', ws);
  console.log(`The minions are working. Gru's commands: team status, team decide, team down.`);
}

main().catch((e) => {
  console.error(`team-up: ${e.message}`);
  process.exit(1);
});
