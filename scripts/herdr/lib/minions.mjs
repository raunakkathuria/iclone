// The minions: one file per minion in team/minions/, and the settings each team gives them.
//
// A minion file starts with "key: value" lines between two "---" lines: tool, model, effort,
// job (one line the whole team sees), start (its first prompt), and missing (what the team does
// when this minion is not in it). The rest of the file is its role. To add a minion, add a file.
// _rules.md holds the rules every minion follows.
//
// Settings come in three layers, each overriding the one before: the minion's file, config.json
// next to this folder (every project), and .team/team.json in a project (that project only).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FOLDER = join(REPO_ROOT, 'team', 'minions');
// Every team has a builder and a reviewer, the pair. A team that names no others gets these too.
export const CORE = ['builder', 'reviewer'];
export const DEFAULT_EXTRAS = ['product', 'qa'];

// The "key: value" lines between the "---" lines at the top, and the role text after them.
export function parseMinion(text) {
  const head = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const minion = { role: head ? text.slice(head[0].length) : text };
  for (const line of (head?.[1] ?? '').split('\n')) {
    const at = line.indexOf(':');
    if (at > 0 && line.slice(at + 1).trim()) minion[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return minion;
}

// Every minion, by name (builder.md is "builder"): the pair first, then the others by name.
export function loadMinions(folder = FOLDER) {
  const rank = (name) => (CORE.includes(name) ? CORE.indexOf(name) : CORE.length);
  const names = readdirSync(folder).filter((f) => f.endsWith('.md') && !f.startsWith('_')).map((f) => f.slice(0, -3))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return Object.fromEntries(names.map((name) => [name, parseMinion(readFileSync(join(folder, `${name}.md`), 'utf8'))]));
}

// The project that holds dir: the nearest folder, from dir up, with a .team/ folder. Or null.
export function projectOf(dir) {
  for (let d = dir; d; d = dirname(d) === d ? null : dirname(d)) {
    if (existsSync(join(d, '.team'))) return d;
  }
  return null;
}

// Where a minion's prompt is saved in a project.
export const promptFile = (root, name) => join(root, '.team', 'prompts', `${name}.md`);

// A project's .team/team.json, or null: { "minions": { "<name>": { tool, model, effort } } }.
export function readTeam(root) {
  try { return JSON.parse(readFileSync(join(root, '.team', 'team.json'), 'utf8')); } catch { return null; }
}

// The minions of a team, in order: the pair, then the others in team.json, or the default ones
// when the team names none.
export function teamMembers(team) {
  const named = Object.keys(team?.minions ?? {}).filter((name) => !CORE.includes(name));
  return [...CORE, ...(team?.minions ? named : DEFAULT_EXTRAS)];
}

// A minion's tool, model and effort: its file, then config.json, then the project's team.json.
// A config value is a tool name ("codex") or an object ({ "tool": "codex", "model": "o3" }).
export function settingsOf(name, minions, config = {}, team = null) {
  const layer = (value) => (typeof value === 'string' ? { tool: value } : value ?? {});
  const { tool = 'claude', model, effort } = minions[name] ?? {};
  return { tool, model, effort, ...layer(config[name]), ...layer(team?.minions?.[name]) };
}

// The prompt a team minion starts with: the shared rules, this team's minions, what the team does
// for a minion it does not have, and the minion's own role. It is saved in .team/prompts/ so Gru
// can read exactly what each minion was told. Returns the file's path.
export function writePrompt(root, name, minions, members, folder = FOLDER) {
  const roster = members.map((member) => `- **${member}-minion**: ${minions[member]?.job ?? ''}`);
  const gaps = Object.entries(minions).filter(([member, m]) => !members.includes(member) && m.missing)
    .map(([member, m]) => `- This team has no ${member}-minion: ${m.missing}`);
  const parts = [
    readFileSync(join(folder, '_rules.md'), 'utf8').trim(),
    ['## This team', ...roster, ...(gaps.length ? ['', ...gaps] : [])].join('\n'),
    minions[name].role.trim(),
  ];
  const file = promptFile(root, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${parts.join('\n\n')}\n`);
  return file;
}
