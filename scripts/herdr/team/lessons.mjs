// The lesson list in a project's .team/LESSONS.md. Pure functions on the file's text: team learn
// adds a lesson with them, and the callers read and write the files.
//
// A lesson is a line "L-n <rule>. Why: <source>." between the "## Lessons" and "## Watching"
// headings. With no Watching heading, the section ends at the end of the file.

export const LIMIT = 15;
const LESSON = /^L-(\d+)\b/;

// The text after the ID: "<rule>. Why: <source>.", with no second "." when one is there.
const sentence = (text) => (text.endsWith('.') ? text : `${text}.`);
export const lessonBody = (rule, source) => `${sentence(rule)} Why: ${sentence(source)}`;

// Adds "L-<next> <body>" as the last line of the Lessons section. Returns the new text and the ID.
// Throws when there is no Lessons heading, or when the section already has LIMIT lessons.
export function addLesson(text, body) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## Lessons\b/.test(l));
  if (start < 0) throw new Error('has no "## Lessons" heading. Add it, then try again.');
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## Watching'));
  const end = next < 0 ? lines.length : next;
  if (lines.slice(start + 1, end).filter((l) => LESSON.test(l)).length >= LIMIT) {
    throw new Error(`has ${LIMIT} lessons, the most it can hold. Merge two lessons or drop one, then try again.`);
  }
  // The next number comes from the whole file, so a dropped number is never used again.
  const id = `L-${Math.max(0, ...lines.map((l) => Number(LESSON.exec(l)?.[1] ?? 0))) + 1}`;
  let at = end;
  while (at > start + 1 && !lines[at - 1].trim()) at--;
  // An empty section gets a blank line after its heading, and the next heading keeps one before it.
  const added = [...(at === start + 1 ? [''] : []), `${id} ${body}`, ...(lines[at]?.startsWith('## ') ? [''] : [])];
  lines.splice(at, 0, ...added);
  return { text: lines.join('\n'), id };
}
