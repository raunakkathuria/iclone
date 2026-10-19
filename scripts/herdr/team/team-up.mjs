#!/usr/bin/env node
// team-up [minion...]: starts the minion team of the project in this folder, in Herdr.
//
//   team-up              the minions in .team/team.json; the first time: builder, reviewer, product, qa
//   team-up qa           the first time: builder and reviewer, plus qa
//   team-up security     on a running team: adds the security minion (team/minions/security.md)
//
// 1. Creates .team/ from the templates. It never overwrites a file that is there. A new
//    LESSONS.md also gets every lesson in the global list, from team promote.
// 2. Writes the team's minions to .team/team.json. Gru can set each one's tool, model and effort
//    there too. The builder and the reviewer are always in.
// 3. Stops while .team/GOAL.md is still the template: Gru writes the goal first.
// 4. Opens a workspace named "<project> minions". The layout code (ensureLayout in
//    lib/herdr.mjs, also run by the Herdr plugin) fills it with the minions, each with its role.
// 5. Sends each new minion its first prompt: the "start" line in its file.
// 6. Gives Gru two seats, when they are missing: a "gru" pane under the minions that runs
//    team watch, and a "log" tab that shows every message.
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINIONS, ensureLayout, findTeam, herdr, roleNote, sendPrompt, sleep, teamLabel, waitReady } from '../lib/herdr.mjs';
import { CORE, DEFAULT_EXTRAS, loadMinions, promptFile, readTeam, teamMembers } from '../lib/minions.mjs';
import { LIMIT, PROMOTED, addLesson, promotedBodies } from './lessons.mjs';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), 'templates');
const MINION_FILES = loadMinions();

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
  // The log and the generated prompts are not part of the record git keeps.
  const ignore = join(team, '.gitignore');
  const ignored = existsSync(ignore) ? readFileSync(ignore, 'utf8').split('\n') : [];
  const missing = ['LOG.md', 'prompts/'].filter((line) => !ignored.includes(line));
  if (missing.length) appendFileSync(ignore, `${ignored.length && ignored.at(-1) !== '' ? '\n' : ''}${missing.join('\n')}\n`);
  return readFileSync(join(team, 'GOAL.md'), 'utf8') === readFileSync(join(TEMPLATES, 'GOAL.md'), 'utf8');
}

// Writes the team's minions to .team/team.json: the ones already there, with their settings,
// plus the names asked for. The first time, with no names, the pair plus the default minions.
// Returns the minions that are new to the team.
function chooseMinions(root, names) {
  const team = readTeam(root);
  const unknown = [...names, ...Object.keys(team?.minions ?? {})].filter((name) => !MINION_FILES[name]);
  if (unknown.length) throw new Error(`there is no minion named ${unknown.join(', ')}. The minions: ${Object.keys(MINION_FILES).join(', ')}.`);
  const before = team ? teamMembers(team) : [];
  const minions = { ...(team?.minions ?? Object.fromEntries([...CORE, ...(names.length ? [] : DEFAULT_EXTRAS)].map((name) => [name, {}]))) };
  for (const name of names) minions[name] ??= {};
  if (!team || names.some((name) => !(name in team.minions))) {
    writeFileSync(join(root, '.team', 'team.json'), `${JSON.stringify({ ...team, minions }, null, 2)}\n`);
  }
  return teamMembers({ minions }).filter((name) => !before.includes(name));
}

// Waits until every minion of the team has a tool running. The plugin may be building the same
// workspace; ensureLayout then returns null, and this tries again.
async function layout(ws, members) {
  for (let i = 0; i < 60; i++) {
    const panes = await ensureLayout(ws);
    const running = new Set(herdr('pane', 'list', '--workspace', ws).panes.filter((p) => p.agent).map((p) => p.pane_id));
    if (panes && members.every((role) => running.has(panes[role]))) return panes;
    await sleep(3000);
  }
  throw new Error(`the minions in workspace ${ws} did not all start. Look at the panes for a question to answer.`);
}

// Types a command into a plain shell pane. A new shell needs a moment before it takes input.
async function runIn(pane, command) {
  await sleep(1500);
  herdr('pane', 'send-text', pane, command);
  herdr('pane', 'send-keys', pane, 'enter');
}

// Gru's seats: a small "gru" pane at the bottom of the right column, running team watch, and a
// "log" tab with every message. Adds the ones that are missing.
async function seats(ws, root, panes, members) {
  const labels = herdr('pane', 'list', '--workspace', ws).panes.map((p) => p.label);
  if (!labels.includes('gru')) {
    // The right column: the reviewer, then every second minion after the pair.
    const right = members.filter((_, i) => i === 1 || (i > 1 && i % 2 === 1));
    const id = herdr('pane', 'split', '--pane', panes[right.at(-1)], '--direction', 'down', '--ratio', '0.6',
      '--cwd', root, '--no-focus').pane.pane_id;
    herdr('pane', 'rename', id, 'gru');
    await runIn(id, 'team watch');
  }
  if (!labels.includes('log')) {
    const id = herdr('tab', 'create', '--workspace', ws, '--cwd', root, '--label', 'log', '--no-focus').root_pane.pane_id;
    herdr('pane', 'rename', id, 'log');
    await runIn(id, 'tail -n 30 -F .team/LOG.md');
  }
}

// Sends a minion its first prompt. A new tool can wait at a question first, such as "Do you trust
// this folder?"; then Gru answers it in the pane, and this waits.
async function kickoff(root, pane, role) {
  const text = MINION_FILES[role].start ?? `Read ${promptFile(root, role)}, then wait for work.`;
  const { agent: kind, agent_status: status } = herdr('agent', 'get', pane).agent;
  if (status === 'blocked') console.log(`${MINIONS[role]} waits at a question in pane ${pane}. Answer it there.`);
  try {
    if ((await waitReady(pane, MINIONS[role], 30 * 60_000)) && (await sendPrompt(pane, roleNote(role, kind, promptFile(root, role)) + text))) return;
  } catch (e) {
    if (e.code !== 'agent_blocked') throw e;
  }
  console.error(`team-up: ${MINIONS[role]} did not take its first prompt. Send it yourself: ${text}`);
}

async function main() {
  const names = process.argv.slice(2);
  const root = gitRoot(process.cwd()) ?? process.cwd();
  const needsGoal = scaffold(root);
  const added = chooseMinions(root, names);
  const members = teamMembers(readTeam(root));
  if (needsGoal) {
    console.log(`Created ${join(root, '.team')} for ${members.map((m) => MINIONS[m]).join(', ')}. Write the goal in .team/GOAL.md, then run team-up again.`);
    return;
  }
  const running = findTeam(root);
  const ws = running?.workspace_id ?? herdr('workspace', 'create', '--cwd', root, '--label', teamLabel(root), '--no-focus').workspace.workspace_id;
  // A new team gets every first prompt; a running team only those of the minions it just gained.
  const starting = running ? added : members;
  if (starting.length) console.log(`Starting ${starting.map((m) => MINIONS[m]).join(', ')} in workspace ${ws}. This takes about a minute.`);
  const panes = await layout(ws, members);
  await seats(ws, root, panes, members);
  for (const role of starting) await kickoff(root, panes[role], role);
  // The minions already at work started with the old team list, so they are told who joined.
  for (const role of running ? members.filter((m) => !starting.includes(m)) : []) {
    for (const added of starting) {
      try {
        herdr('agent', 'prompt', panes[role], `Gru added ${MINIONS[added]} to the team. Its job: ${MINION_FILES[added].job ?? 'see its role'}. From now on it does that work, as your rules say.`);
      } catch (e) { console.error(`team-up: could not tell ${MINIONS[role]} about ${MINIONS[added]}: ${e.code}`); }
    }
  }
  herdr('workspace', 'focus', ws);
  console.log(running && !starting.length
    ? `The minions of ${teamLabel(root)} are already running, in workspace ${ws}.`
    : `The minions are working. Gru's commands: team status, team decide, team down.`);
}

main().catch((e) => {
  console.error(`team-up: ${e.message}`);
  process.exit(1);
});
