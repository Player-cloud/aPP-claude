// Review of a finished change (M6: FR-BUILD-001/002/003). These are
// deterministic checks on the diff and the check results, so the report says
// what actually happened instead of what the agent claims. Each finding is a
// risk for the person to judge; none of them is hidden.

import { ranNoTests, type CheckResult } from './checks.ts';
import type { ChangedFile } from './git.ts';

export interface Risk {
  kind: 'regression' | 'still_failing' | 'not_run' | 'not_reproduced' | 'unrelated_file' | 'weakened_test' | 'deleted_test' | 'no_test' | 'no_change' | 'truncated' | 'no_tests_ran';
  detail: string;
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]*\.py$|Tests?\.(java|cs|kt)$/i;
/** Added lines that switch a test off or narrow a run to one test. */
const WEAKENING = /\.(skip|only|todo)\s*\(|\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(|\{\s*skip\s*:\s*true|\bskip\s*:\s*true|@pytest\.mark\.(skip|xfail)|@(Ignore|Disabled)\b|\bt\.Skip\(|\[Ignore\]|\[Fact\(Skip/;

export const isTestFile = (path: string) => TEST_FILE.test(path);

/** Paths are in the repository's own spelling (forward slashes). A component is a file or folder prefix. */
function inComponents(path: string, components: string[]): boolean {
  return components.some((c) => {
    const prefix = c.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return prefix === '' || path === prefix || path.startsWith(`${prefix}/`);
  });
}

/** Lines added to each file in a unified diff. */
function addedLines(patch: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let file = '';
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '');
      out.set(file, []);
    } else if (line.startsWith('+') && file && file !== '/dev/null') out.get(file)!.push(line.slice(1));
  }
  return out;
}

export function reviewChange(input: {
  kind: 'feature' | 'bugfix';
  files: ChangedFile[];
  patch: string;
  truncated: boolean;
  components: string[];
  baseline: CheckResult[];
  final: CheckResult[];
}): Risk[] {
  const risks: Risk[] = [];
  const { files, components } = input;
  if (files.length === 0) risks.push({ kind: 'no_change', detail: 'Nothing changed in the worktree.' });
  if (input.truncated) risks.push({ kind: 'truncated', detail: 'The diff is too long to review in full here; read it with git.' });

  for (const r of input.final) {
    const before = input.baseline.find((b) => b.checkId === r.checkId);
    if (r.status === 'not_run') risks.push({ kind: 'not_run', detail: `Check "${r.checkId}" did not run.` });
    else if (r.status !== 'passed' && before?.status === 'passed') risks.push({ kind: 'regression', detail: `Check "${r.checkId}" passed before the change and ${r.status === 'failed' ? 'fails' : r.status.replace('_', ' ')} now.` });
    else if (r.status !== 'passed') risks.push({ kind: 'still_failing', detail: `Check "${r.checkId}" ${r.status === 'failed' ? 'fails' : r.status.replace('_', ' ')}.` });
    else if (ranNoTests(r.output)) risks.push({ kind: 'no_tests_ran', detail: `Check "${r.checkId}" passed but found no tests, so it proves nothing about the change.` });
  }
  if (input.kind === 'bugfix' && input.baseline.length && input.baseline.every((b) => b.status === 'passed')) {
    risks.push({ kind: 'not_reproduced', detail: 'Every check passed before the fix, so the bug was not reproduced by a check.' });
  }

  if (components.length) {
    for (const f of files) {
      if (!inComponents(f.path, components)) risks.push({ kind: 'unrelated_file', detail: `${f.path} is outside the listed components (${components.join(', ')}).` });
    }
  }

  const added = addedLines(input.patch);
  for (const f of files) {
    if (!isTestFile(f.path)) continue;
    if (f.status === 'deleted') risks.push({ kind: 'deleted_test', detail: `Test file ${f.path} was deleted.` });
    const hit = (added.get(f.path) ?? []).find((l) => WEAKENING.test(l));
    if (hit) risks.push({ kind: 'weakened_test', detail: `${f.path} adds a skipped or narrowed test: ${hit.trim().slice(0, 160)}` });
  }
  if (files.length && !files.some((f) => isTestFile(f.path) && f.status !== 'deleted')) {
    risks.push({
      kind: 'no_test',
      detail: input.kind === 'bugfix' ? 'No regression test was added or changed. Say why if one is not practical.' : 'No test was added or changed for this feature.',
    });
  }
  return risks;
}
