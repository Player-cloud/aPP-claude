// Search for the launcher (M17 L, DEC-034): tasks, the files they changed, open
// to-dos and lessons, found by every word typed. Reading only: the launcher's
// actions go through the usual handlers.
import type { LearningSource } from './learn/lessons.ts';
import type { Build, Project, Todo } from './workspace.ts';

export type SearchHit =
  | { kind: 'task'; buildId: string; projectName: string; title: string; status: Build['status'] }
  | { kind: 'file'; buildId: string; projectName: string; path: string; taskTitle: string }
  | { kind: 'todo'; todoId: string; buildId: string; projectName: string; text: string; taskTitle: string }
  | { kind: 'lesson'; sourceId: string; number: number; title: string; text: string };

/** At most this many of each kind, so one kind can't push the others out of view. */
export const SEARCH_LIMIT = 6;

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (ws: string[], ...text: (string | null | undefined)[]) => {
  const hay = text.filter(Boolean).join(' ').toLowerCase();
  return ws.every((w) => hay.includes(w));
};

export function searchWork(
  query: string,
  data: { projects: Project[]; builds: Build[]; todos: Todo[]; sources: LearningSource[] },
): SearchHit[] {
  const ws = words(query);
  if (!ws.length) return [];
  const projectName = new Map(data.projects.map((p) => [p.id, p.name]));
  const builds = [...data.builds].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const byId = new Map(builds.map((b) => [b.id, b]));
  const name = (b: Build) => projectName.get(b.projectId) ?? '';

  const tasks: SearchHit[] = builds
    .filter((b) => matches(ws, b.title, b.goal, name(b)))
    .slice(0, SEARCH_LIMIT)
    .map((b) => ({ kind: 'task', buildId: b.id, projectName: name(b), title: b.title, status: b.status }));

  const files: SearchHit[] = [];
  const seen = new Set<string>();
  for (const b of builds) {
    for (const f of b.changedFiles ?? []) {
      // The newest task that changed a file stands for it.
      if (files.length >= SEARCH_LIMIT || seen.has(f.path) || !matches(ws, f.path)) continue;
      seen.add(f.path);
      files.push({ kind: 'file', buildId: b.id, projectName: name(b), path: f.path, taskTitle: b.title });
    }
  }

  const todos: SearchHit[] = data.todos
    .filter((t) => t.status === 'open' && byId.has(t.buildId) && matches(ws, t.text))
    .slice(0, SEARCH_LIMIT)
    .map((t) => {
      const b = byId.get(t.buildId)!;
      return { kind: 'todo', todoId: t.id, buildId: t.buildId, projectName: name(b), text: t.text, taskTitle: b.title };
    });

  const lessons: SearchHit[] = [];
  for (const s of data.sources) {
    const reading = s.extractions.at(-1);
    if (!reading) continue;
    for (const l of reading.lessons) {
      if (lessons.length < SEARCH_LIMIT && matches(ws, l.text, s.title)) lessons.push({ kind: 'lesson', sourceId: s.id, number: s.number, title: s.title, text: l.text });
    }
  }

  return [...tasks, ...todos, ...files, ...lessons];
}
