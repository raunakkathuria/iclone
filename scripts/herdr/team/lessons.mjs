// The lesson list in a project's .team/LESSONS.md, and the global list of promoted lessons. Pure
// functions on the files' text: team learn and team promote use them, and the callers read and
// write the files.
//
// A lesson is a line "L-n <rule>. Why: <source>." between the "## Lessons" and "## Watching"
// headings. With no Watching heading, the section ends at the end of the file. A line seen once
// waits under Watching as "W-n <rule>. Why: <source>.", written by hand.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMIT = 15;
const LESSON = /^L-(\d+)\b/;
const FULL = `has ${LIMIT} lessons, the most it can hold. Merge two lessons or drop one, then try again.`;

// The global list lives in Guru's iclone checkout. Installed, this folder's promoted-lessons.md is
// a link to it (D-1), so team promote and team-up reach the checkout. Tests set the variable.
export const PROMOTED = process.env.HERDR_PROMOTED_LESSONS || join(dirname(fileURLToPath(import.meta.url)), 'promoted-lessons.md');

// The text after the ID: "<rule>. Why: <source>.", with no second "." when one is there.
const sentence = (text) => (text.endsWith('.') ? text : `${text}.`);
export const lessonBody = (rule, source) => `${sentence(rule)} Why: ${sentence(source)}`;

// "Why:" separates the rule from the source, so the text after an ID must have it exactly once.
export const oneWhy = (body) => body.split('Why:').length === 2;
const ruleOf = (body) => body.slice(0, body.indexOf('Why:')).trim();

// The Lessons section as line indexes: its heading (-1 when there is none) and the line after it.
function lessonsSection(lines) {
  const start = lines.findIndex((l) => /^## Lessons\b/.test(l));
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## Watching'));
  return { start, end: start < 0 || next < 0 ? lines.length : next };
}

// The line "<id> <body>" after the heading at start and before end. Returns its index and body.
// Throws when there is no such line, or its body breaks oneWhy.
function findLine(lines, id, heading, start, end) {
  const at = start < 0 ? -1 : lines.findIndex((l, i) => i > start && i < end && l.startsWith(`${id} `));
  if (at < 0) throw new Error(`has no ${id} under "${heading}".`);
  const body = lines[at].slice(id.length).trim();
  if (!oneWhy(body)) throw new Error(`has ${id}, which must have exactly one "Why:". Fix that line by hand, then try again.`);
  return { at, body };
}

// The body of the lesson "<id> <body>" under "## Lessons". Throws like findLine.
export function findLesson(text, id) {
  const lines = text.split('\n');
  const { start, end } = lessonsSection(lines);
  return findLine(lines, id, '## Lessons', start, end).body;
}

// Takes the line "<id> <body>" out of the Watching section, which ends at the next "## " heading.
// Returns the new text and the body. Throws like findLine.
export function takeWatching(text, id) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## Watching'));
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  const { at, body } = findLine(lines, id, '## Watching', start, next < 0 ? lines.length : next);
  lines.splice(at, 1);
  return { text: lines.join('\n'), body };
}

// Adds "L-<next> <body>" as the last line of the Lessons section. Returns the new text and the ID.
// Throws when there is no Lessons heading, or when the section already has LIMIT lessons.
export function addLesson(text, body) {
  const lines = text.split('\n');
  const { start, end } = lessonsSection(lines);
  if (start < 0) throw new Error('has no "## Lessons" heading. Add it, then try again.');
  if (lines.slice(start + 1, end).filter((l) => LESSON.test(l)).length >= LIMIT) throw new Error(FULL);
  // The next number comes from the whole file, so a dropped number is never used again.
  const id = `L-${Math.max(0, ...lines.map((l) => Number(LESSON.exec(l)?.[1] ?? 0))) + 1}`;
  let at = end;
  while (at > start + 1 && !lines[at - 1].trim()) at--;
  // An empty section gets a blank line after its heading, and the next heading keeps one before it.
  const added = [...(at === start + 1 ? [''] : []), `${id} ${body}`, ...(lines[at]?.startsWith('## ') ? [''] : [])];
  lines.splice(at, 0, ...added);
  return { text: lines.join('\n'), id };
}

// The lessons in the global list. Each is a line "- <rule>. Why: <source>. Promoted from <project>
// <L-n>.", and its text after "- " is the body of a new project's lesson.
export const promotedBodies = (text) => text.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());

// Adds the lesson body, promoted from "<project> <L-n>", to the end of the global list's text.
// Throws when the list already has LIMIT lessons, or one with the same rule.
export function addPromoted(text, body, from) {
  const bodies = promotedBodies(text);
  if (bodies.length >= LIMIT) throw new Error(FULL);
  if (bodies.some((b) => ruleOf(b) === ruleOf(body))) throw new Error(`has this rule already, so it is already promoted: ${ruleOf(body)}`);
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}- ${body} Promoted from ${from}.\n`;
}
