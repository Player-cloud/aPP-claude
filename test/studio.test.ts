// M9 Learning Studio: design references are checked by content, copied into the
// app, tagged and searched, and described by the model only as a suggestion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { solidPng, tempHome } from './helpers.ts';
import { Workspace } from '../src/core/workspace.ts';
import { appPaths } from '../src/core/paths.ts';
import { ModelCallError } from '../src/core/errors.ts';
import { SimulatedModel, type ModelRequest } from '../src/core/agents/model.ts';
import { Studio } from '../src/core/studio/library.ts';
import { dimensions, sniff } from '../src/core/studio/media.ts';
import { Planner } from '../src/core/planner.ts';
import { AppService } from '../src/main/service.ts';
import { serveReference } from '../src/main/references.ts';

const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

function setup(t: { after: (fn: () => void) => void }) {
  const { home, cleanup } = tempHome();
  const ws = Workspace.open(home);
  t.after(() => {
    ws.close();
    cleanup();
  });
  const files = join(home, 'incoming');
  mkdirSync(files);
  const put = (name: string, data: Buffer | string) => {
    writeFileSync(join(files, name), data);
    return join(files, name);
  };
  return { home, ws, files, put, studio: new Studio(ws, new SimulatedModel()) };
}

const gif = (w: number, h: number) => {
  const b = Buffer.alloc(32);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
};
const jpeg = (w: number, h: number) => {
  // SOI, an APP0 segment to skip, then a baseline SOF0 carrying the size.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]);
};
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(64)]);

test('M9: the media type comes from the bytes, and sizes are read from the header', () => {
  assert.equal(sniff(solidPng(3, 2, [0, 0, 0])), 'image/png');
  assert.deepEqual(dimensions(solidPng(640, 360, [1, 2, 3]), 'image/png'), { width: 640, height: 360 });
  assert.deepEqual(dimensions(gif(48, 32), 'image/gif'), { width: 48, height: 32 });
  assert.equal(sniff(jpeg(1920, 1080)), 'image/jpeg');
  assert.deepEqual(dimensions(jpeg(1920, 1080), 'image/jpeg'), { width: 1920, height: 1080 });
  assert.equal(sniff(mp4()), 'video/mp4');
  assert.equal(sniff(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  ', 'latin1')])), 'video/quicktime');
  assert.equal(sniff(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0])), 'video/webm');
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniff(Buffer.from('%PDF-1.7')), null);
});

test('M9: importing copies checked files into the app and leaves the originals alone', (t) => {
  const { ws, put, studio } = setup(t);
  const png = put('Checkout_screen-dark.png', solidPng(320, 200, [20, 30, 60]));
  const before = readFileSync(png);
  const mtime = statSync(png).mtimeMs;
  const svg = put('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const renamed = put('notes.png', 'just some text, not a picture');
  const result = studio.importFiles([png, svg, renamed, join(ws.paths.home, 'missing.png'), 'relative.png'], null);

  assert.equal(result.imported.length, 1);
  const r = result.imported[0]!;
  assert.equal(r.title, 'Checkout screen dark');
  assert.equal(r.mediaType, 'image/png');
  assert.deepEqual([r.width, r.height], [320, 200]);
  assert.ok(r.storedPath.startsWith(appPaths(ws.paths.home).references));
  assert.deepEqual(readFileSync(r.storedPath), before, 'the copy is byte for byte the checked file');
  assert.deepEqual(readFileSync(png), before, 'the original is unchanged');
  assert.equal(statSync(png).mtimeMs, mtime);

  assert.deepEqual(
    result.skipped.map((s) => [s.file, /SVG is not accepted|does not exist|full path/.exec(s.reason)?.[0] ?? s.reason]),
    [
      ['logo.svg', 'SVG is not accepted'],
      ['notes.png', 'SVG is not accepted'],
      ['missing.png', 'does not exist'],
      ['relative.png', 'full path'],
    ],
  );
  // The same bytes under another name are not stored twice.
  const again = studio.importFiles([put('copy.png', before)], null);
  assert.equal(again.imported.length, 0);
  assert.match(again.skipped[0]!.reason, /already in the library as "Checkout screen dark"/);
  assert.equal(readdirSync(ws.paths.references).length, 1);
  assert.throws(() => studio.importFiles([], null), /at least one file/);
  assert.throws(() => studio.importFiles(Array.from({ length: 51 }, (_, i) => `/x/${i}.png`), null), /at most 50/);
});

test('M9: folders and links are refused, and the default kind follows the format', (t) => {
  const { files, put, studio } = setup(t);
  const real = put('real.png', solidPng(4, 4, [9, 9, 9]));
  const link = join(files, 'link.png');
  try {
    symlinkSync(real, link);
  } catch {
    t.skip('this system cannot create symbolic links');
    return;
  }
  const r = studio.importFiles([files, link, put('spinner.gif', gif(16, 16)), put('demo.mp4', mp4())], null);
  assert.deepEqual(
    r.skipped.map((s) => s.file),
    ['incoming', 'link.png'],
  );
  assert.deepEqual(
    r.imported.map((x) => [x.fileName, x.kind]),
    [
      ['spinner.gif', 'animation'],
      ['demo.mp4', 'video'],
    ],
  );
});

test('M9: tags, notes and project links are validated, searchable and audited', (t) => {
  const { ws, put, studio } = setup(t);
  const project = ws.createProject({ name: 'Club HR' });
  const [a, b] = studio.importFiles([put('onboarding.png', solidPng(8, 8, [1, 1, 1])), put('pricing.png', solidPng(8, 8, [2, 2, 2]))], project.id).imported;
  assert.equal(a!.projectId, project.id);

  const edited = studio.update(a!.id, { tags: ['Empty State', 'onboarding', 'onboarding'], notes: 'Borrow the friendly empty state.', kind: 'screenshot' });
  assert.deepEqual(edited.tags, ['empty-state', 'onboarding']);
  assert.throws(() => studio.update(a!.id, { tags: ['no/slash'] }), /is not a tag/);
  assert.throws(() => studio.update(a!.id, { kind: 'poster' }), /Kind must be one of/);
  assert.throws(() => studio.update(a!.id, { title: '  ' }), /Title is required/);
  assert.throws(() => studio.update(a!.id, { projectId: 'prj_nope' }), /not found|No project/i);
  studio.update(b!.id, { projectId: null, tags: ['pricing'] });

  assert.deepEqual(studio.list({ query: 'friendly EMPTY' }).map((r) => r.id), [a!.id]);
  assert.deepEqual(studio.list({ tag: 'pricing' }).map((r) => r.id), [b!.id]);
  assert.deepEqual(studio.list({ projectId: project.id }).map((r) => r.id), [a!.id]);
  assert.deepEqual(studio.list({ projectId: null }).map((r) => r.id), [b!.id]);
  assert.deepEqual(studio.list({ kind: 'screenshot' }).map((r) => r.id), [a!.id]);
  assert.deepEqual(studio.tagCounts(), [
    { tag: 'empty-state', count: 1 },
    { tag: 'onboarding', count: 1 },
    { tag: 'pricing', count: 1 },
  ]);
  const types = ws.listEvents({ limit: 50 }).map((e) => e.type);
  assert.ok(types.includes('reference.imported') && types.includes('reference.updated'), types.join(', '));
});

test('M9: a suggestion is only applied when accepted, and a change marks it corrected', async (t) => {
  const { ws, put } = setup(t);
  const seen: Omit<ModelRequest, 'signal'>[] = [];
  const model = new SimulatedModel((req) => {
    seen.push(req);
    return { text: JSON.stringify({ kind: 'ui_design', tags: ['Dashboard', 'dark mode', '!!bad!!', 'charts'], explanation: 'A dark analytics dashboard with a left rail.' }) };
  });
  const studio = new Studio(ws, model);
  const [r] = studio.importFiles([put('dash.png', solidPng(16, 9, [5, 5, 5]))], null).imported;
  studio.update(r!.id, { tags: ['mine'] });

  const s = await studio.suggest(r!.id);
  assert.equal(s.kind, 'other', 'nothing is applied yet');
  assert.deepEqual(s.tags, ['mine']);
  assert.deepEqual(s.suggestion && { kind: s.suggestion.kind, tags: s.suggestion.tags, status: s.suggestion.status }, { kind: 'ui_design', tags: ['dashboard', 'dark-mode', 'charts'], status: 'proposed' });
  assert.equal(seen[0]!.purpose, 'classify');
  assert.equal(seen[0]!.image, undefined, 'the simulated model is not sent the picture');

  const accepted = studio.acceptSuggestion(r!.id);
  assert.equal(accepted.kind, 'ui_design');
  assert.deepEqual(accepted.tags, ['mine', 'dashboard', 'dark-mode', 'charts']);
  assert.equal(accepted.explanation, 'A dark analytics dashboard with a left rail.');
  assert.throws(() => studio.acceptSuggestion(r!.id), /no open suggestion/);

  await studio.suggest(r!.id);
  const corrected = studio.update(r!.id, { kind: 'screenshot' });
  assert.equal(corrected.suggestion?.status, 'corrected');
  assert.equal(corrected.kind, 'screenshot');
  // Editing only the notes is not a correction.
  await studio.suggest(r!.id);
  assert.equal(studio.update(r!.id, { notes: 'ok' }).suggestion?.status, 'proposed');
});

test('M9: an answer off the list is dropped, and broken JSON saves nothing', async (t) => {
  const { ws, put } = setup(t);
  const [r] = new Studio(ws, new SimulatedModel()).importFiles([put('x.png', solidPng(4, 4, [0, 0, 0]))], null).imported;
  const odd = await new Studio(ws, new SimulatedModel(() => ({ text: JSON.stringify({ kind: 'masterpiece', tags: 'not a list', explanation: 'x'.repeat(5000) }) }))).suggest(r!.id);
  assert.equal(odd.suggestion?.kind, 'other');
  assert.deepEqual(odd.suggestion?.tags, []);
  assert.equal(odd.suggestion?.explanation.length, 1500);
  await assert.rejects(new Studio(ws, new SimulatedModel(() => ({ text: 'Looks nice!' }))).suggest(r!.id), (e: Error) => e instanceof ModelCallError && /not valid JSON/.test(e.message));
  assert.equal(ws.getReference(r!.id).suggestion?.kind, 'other', 'the earlier suggestion is kept');
});

test('M9: real calls send the image, respect the budget and refuse videos and large images', async (t) => {
  const { ws, put } = setup(t);
  const seen: Omit<ModelRequest, 'signal'>[] = [];
  const billable = new SimulatedModel(
    (req) => {
      seen.push(req);
      return { text: JSON.stringify({ kind: 'screenshot', tags: ['form'], explanation: 'A sign-up form.' }), costUsd: 0.02 };
    },
    { billable: true },
  );
  const studio = new Studio(ws, billable);
  const png = solidPng(10, 10, [200, 100, 50]);
  const [img, vid] = studio.importFiles([put('form.png', png), put('demo.mp4', mp4())], null).imported;

  await assert.rejects(studio.suggest(img!.id), (e: Error) => e instanceof ModelCallError && e.code === 'BUDGET_BLOCKED');
  assert.equal(ws.getReference(img!.id).suggestion, null);

  ws.updateSetting('budget', '20');
  const s = await studio.suggest(img!.id);
  assert.equal(s.suggestion?.kind, 'screenshot');
  assert.deepEqual(seen.at(-1)!.image, { mediaType: 'image/png', data: png.toString('base64') });
  assert.ok(Math.abs(ws.spentThisMonth() - 0.02) < 1e-9);
  await assert.rejects(studio.suggest(vid!.id), /cannot watch videos/);

  // Over 5 MB: refused before any call is made.
  const big = Buffer.concat([solidPng(2, 2, [1, 1, 1]), Buffer.alloc(5_100_000)]);
  const [large] = studio.importFiles([put('big.png', big)], null).imported;
  const calls = seen.length;
  await assert.rejects(studio.suggest(large!.id), /larger than 5 MB/);
  assert.equal(seen.length, calls);
});

test('M9: references are archived, never deleted, and never change a spec', async (t) => {
  const { home, ws, put, studio } = setup(t);
  const project = ws.createProject({ name: 'Recipes', idea: 'Share recipes with friends.' });
  const planner = new Planner(ws, new SimulatedModel());
  const brief = await planner.draftBrief(project.id);
  const docs = JSON.stringify(ws.listPlanDocs(project.id));
  const [r] = studio.importFiles([put('hero.png', solidPng(8, 8, [3, 3, 3]))], project.id).imported;
  studio.update(r!.id, { notes: 'Use this hero layout', tags: ['hero'] });
  await studio.suggest(r!.id);
  studio.acceptSuggestion(r!.id);
  assert.equal(JSON.stringify(ws.listPlanDocs(project.id)), docs, 'the plan documents are unchanged');
  assert.equal(ws.getPlanDoc(brief.id).updatedAt, brief.updatedAt);

  const archived = studio.archive(r!.id);
  assert.equal(archived.status, 'archived');
  assert.deepEqual(studio.list(), []);
  assert.deepEqual(studio.list({ archived: true }).map((x) => x.id), [r!.id]);
  assert.deepEqual(studio.tagCounts(), [], 'archived references do not count');
  assert.throws(() => studio.update(r!.id, { notes: 'x' }), /archived/);
  await assert.rejects(studio.suggest(r!.id), /archived/);
  assert.ok(existsSync(r!.storedPath), 'the file is kept');
  assert.equal(studio.archive(r!.id, false).status, 'active');

  const db = new DatabaseSync(appPaths(home).db);
  assert.throws(() => db.exec('DELETE FROM design_refs'), /never deleted|cannot be deleted/);
  db.close();
});

test('M9 service: files come only from the picker, and previews only for known ids', async (t) => {
  const { home, cleanup } = tempHome();
  const incoming = join(home, 'in');
  mkdirSync(incoming);
  writeFileSync(join(incoming, 'a.png'), solidPng(6, 6, [7, 7, 7]));
  writeFileSync(join(incoming, 'b.txt'), 'hello');
  let picked: string[] = [];
  const service = new AppService(home, '0.0.0-test', { pickFiles: async () => picked });
  // Close before removing the folder: Windows cannot delete an open database.
  t.after(() => {
    service.close();
    cleanup();
  });
  const h = service.handlers;

  const none = await h.importReferences({});
  assert.ok(none.ok && none.value.imported.length === 0 && none.value.skipped.length === 0, 'cancelling imports nothing');
  picked = [join(incoming, 'a.png'), join(incoming, 'b.txt')];
  const res = await h.importReferences({ projectId: undefined });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.value.imported.length, 1);
  assert.equal(res.value.skipped[0]!.file, 'b.txt');
  const id = res.value.imported[0]!.id;

  // The renderer cannot pass a path: extra arguments are ignored and only the picker is used.
  picked = [];
  const sneaky = await (h.importReferences as (...a: unknown[]) => ReturnType<typeof h.importReferences>)({ paths: ['/etc/passwd'] });
  assert.ok(sneaky.ok && sneaky.value.imported.length === 0);

  const listed = h.listReferences({ query: 'a' });
  assert.ok(listed.ok && listed.value.length === 1);
  const up = h.updateReference({ id, tags: ['Calm'], notes: 'n' });
  assert.ok(up.ok && up.value.tags[0] === 'calm');
  const bad = h.updateReference({ id, tags: ['x/y'] });
  assert.ok(!bad.ok && bad.error.code === 'VALIDATION');
  const sug = await h.suggestReference(id);
  assert.ok(sug.ok && sug.value.suggestion?.model === 'simulated');
  const acc = h.acceptReferenceSuggestion(id);
  assert.ok(acc.ok && acc.value.suggestion?.status === 'accepted');
  const cat = h.referenceCatalog();
  assert.ok(cat.ok && cat.value.kinds.includes('screenshot'));
  const arch = h.archiveReference({ id, archived: true });
  assert.ok(arch.ok && arch.value.status === 'archived');

  assert.equal(service.referenceFile(id)?.mediaType, 'image/png');
  assert.equal(service.referenceFile('../state/workspace.db'), null);
  assert.equal(service.referenceFile('ref_00000000-0000-0000-0000-000000000000'), null);
});

test('M9 CLI: import, tag, search, suggest and archive', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const file = join(home, 'Settings page.png');
  writeFileSync(file, solidPng(12, 8, [40, 40, 40]));
  const iap = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { env: { ...process.env, IAP_HOME: home }, encoding: 'utf8' });
  const imp = iap('ref', 'import', file, '--json');
  assert.equal(imp.status, 0, imp.stderr);
  const id = JSON.parse(imp.stdout).imported[0].id as string;
  assert.equal(iap('ref', 'import', file).status, 1, 'a duplicate alone is a failure');
  assert.equal(iap('ref', 'edit', id, '--tag', 'settings', '--tag', 'forms', '--notes', 'Clear labels').status, 0);
  assert.match(iap('ref', 'list', '--query', 'clear labels').stdout, /Settings page {2}\[settings, forms\]/);
  const sug = iap('ref', 'suggest', id);
  assert.equal(sug.status, 0, sug.stderr);
  assert.match(sug.stdout, /suggestion \(simulated, proposed\): screenshot/);
  assert.equal(iap('ref', 'accept', id).status, 0);
  assert.match(iap('ref', 'show', id).stdout, /screenshot "Settings page"/);
  assert.match(iap('ref', 'archive', id).stdout, /is archived/);
  assert.match(iap('ref', 'list').stdout, /No references match/);
});

test('M9 previews: byte ranges are served so videos can seek', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const path = join(home, 'clip.mp4');
  writeFileSync(path, Buffer.from('0123456789'));
  const file = { path, mediaType: 'video/mp4' };
  const whole = serveReference(file, null);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/mp4');
  assert.equal(whole.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await whole.text(), '0123456789');
  const mid = serveReference(file, 'bytes=2-5');
  assert.deepEqual([mid.status, mid.headers.get('content-range'), await mid.text()], [206, 'bytes 2-5/10', '2345']);
  const open = serveReference(file, 'bytes=7-');
  assert.deepEqual([open.status, await open.text()], [206, '789']);
  const tail = serveReference(file, 'bytes=-3');
  assert.deepEqual([tail.status, await tail.text()], [206, '789']);
  assert.equal(serveReference(file, 'bytes=20-30').status, 416);
});
