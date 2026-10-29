import assert from 'node:assert/strict';
import test from 'node:test';
import type { LearningSource } from '../src/core/learn/lessons.ts';
import { SEARCH_LIMIT, searchWork } from '../src/core/search.ts';
import type { Build, Project, Todo } from '../src/core/workspace.ts';

const project = { id: 'p1', name: 'Club HR' } as Project;
const build = (id: string, title: string, updatedAt: string, files: string[] = []): Build =>
  ({ id, projectId: 'p1', title, goal: title, status: 'completed', updatedAt, changedFiles: files.map((path) => ({ path, added: 1, removed: 0 })) }) as unknown as Build;

test('M17-L: a changed file is found once, under the newest task that changed it', () => {
  const builds = [build('b1', 'Members page', '2026-10-01', ['src/members.tsx', 'src/app.tsx']), build('b2', 'Fix members sort', '2026-10-02', ['src/members.tsx'])];
  const hits = searchWork('members.tsx', { projects: [project], builds, todos: [], sources: [] });
  assert.deepEqual(hits, [{ kind: 'file', buildId: 'b2', projectName: 'Club HR', path: 'src/members.tsx', taskTitle: 'Fix members sort' }]);
  // The newest task comes first, and the project name counts as a word.
  const tasks = searchWork('club members', { projects: [project], builds, todos: [], sources: [] }).filter((h) => h.kind === 'task');
  assert.deepEqual(
    tasks.map((h) => h.kind === 'task' && h.buildId),
    ['b2', 'b1'],
  );
});

test('M17-L: each kind is capped, open to-dos only, and lessons come from the latest reading', () => {
  const builds = Array.from({ length: 10 }, (_, i) => build(`b${i}`, `Report ${i}`, `2026-10-${String(i + 10)}`));
  const todos = [
    { id: 't1', buildId: 'b1', text: 'Add a report test', status: 'open' },
    { id: 't2', buildId: 'b1', text: 'Old report note', status: 'cleared' },
  ] as Todo[];
  const sources = [
    {
      id: 's1',
      number: 3,
      title: 'Design talk',
      extractions: [
        { lessons: [{ n: 1, text: 'Old report lesson', citations: [] }] },
        { lessons: [{ n: 1, text: 'Show the report first', citations: [] }] },
      ],
    },
  ] as unknown as LearningSource[];
  const hits = searchWork('report', { projects: [project], builds, todos, sources });
  assert.equal(hits.filter((h) => h.kind === 'task').length, SEARCH_LIMIT);
  assert.deepEqual(
    hits.filter((h) => h.kind === 'todo').map((h) => h.kind === 'todo' && h.todoId),
    ['t1'],
  );
  assert.deepEqual(
    hits.filter((h) => h.kind === 'lesson').map((h) => h.kind === 'lesson' && h.text),
    ['Show the report first'],
  );
});
