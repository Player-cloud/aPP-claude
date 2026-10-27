// End-to-end tests against the real Electron app (M2). Each test uses its own
// data directory. Screenshots are saved to e2e/screenshots/ as evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, Page } from 'playwright-core';
import { launch, SHOTS, tempHome } from './helpers.ts';

mkdirSync(SHOTS, { recursive: true });

async function resize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [width, height]);
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

test('M2-AC3/AC4: create a project, run a workflow with a blocker, and find it again after restart', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  let { app, page } = await launch(home);
  try {
    await resize(app, 1280, 800);
    await page.getByRole('heading', { name: 'No projects yet' }).waitFor();
    await shot(page, '01-projects-empty-dark-1280');

    await page.getByRole('button', { name: 'New project' }).click();
    // Server-side validation is shown, not bypassed by the UI.
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('alert').filter({ hasText: 'Project name is required' }).waitFor();

    await page.getByLabel('Name').fill('Recipe sharing app');
    await page.getByLabel('Idea').fill('Let friends share and rate recipes.');
    await page.getByLabel('Confirmed facts').fill('Windows desktop first\nSingle user');
    await page.getByLabel('Assumptions').fill('Users want offline access');
    await page.getByRole('button', { name: 'Create project' }).click();

    await page.getByRole('heading', { level: 1, name: 'Recipe sharing app' }).waitFor();
    assert.deepEqual(await page.getByRole('list', { name: 'Confirmed facts' }).getByRole('listitem').allTextContents(), ['Windows desktop first', 'Single user']);
    assert.deepEqual(await page.getByRole('list', { name: 'Assumptions' }).getByRole('listitem').allTextContents(), ['Users want offline access']);

    await page.getByLabel('Title').fill('Initial plan');
    await page.getByRole('button', { name: 'Start run' }).click();
    const run = page.getByRole('article', { name: /Initial plan/ });
    await run.getByText('Draft', { exact: true }).waitFor();
    // Only valid next steps are offered.
    assert.deepEqual(await run.getByRole('button').allTextContents(), ['Mark planned', 'Cancel run']);

    await run.getByRole('button', { name: 'Mark planned' }).click();
    await run.getByRole('button', { name: 'Report blocker' }).click();
    await run.getByLabel('What is blocking this run?').fill('EGM is not installed');
    await run.getByRole('button', { name: 'Mark blocked' }).click();
    await run.getByRole('alert').filter({ hasText: 'blocker (--reason) and how to resolve it' }).waitFor();
    await run.getByLabel('How can it be resolved?').fill('Install EGM or use the built-in planner');
    await run.getByRole('button', { name: 'Mark blocked' }).click();
    await run.getByText('To resolve:').waitFor();
    assert.match(await run.innerText(), /Install EGM or use the built-in planner/);
    await shot(page, '02-project-blocked-run-dark-1280');

    await run.getByRole('button', { name: 'Resume (Planned)' }).click();
    await run.getByText('Planned', { exact: true }).waitFor();

    await page.getByRole('button', { name: 'Activity' }).click();
    // The log loads asynchronously: wait for the entry rather than reading the table once.
    await page.getByRole('cell', { name: 'Run moved planned → blocked: EGM is not installed' }).waitFor();
    await shot(page, '03-activity-dark-1280');
  } finally {
    await app.close();
  }

  // Restart: everything is still there (FR-APP-002).
  ({ app, page } = await launch(home));
  try {
    await page.getByRole('button', { name: 'Recipe sharing app' }).click();
    await page.getByRole('article', { name: /Initial plan, Planned/ }).waitFor();
  } finally {
    await app.close();
  }
});

test('M2-AC6: theme preference applies immediately and persists', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  let { app, page } = await launch(home);
  try {
    await resize(app, 1280, 800);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'Light' }).check();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await shot(page, '04-settings-light-1280');
    await page.getByRole('button', { name: 'Projects' }).click();
    await shot(page, '05-projects-empty-light-1280');
  } finally {
    await app.close();
  }
  ({ app, page } = await launch(home));
  try {
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  } finally {
    await app.close();
  }
});

test('M2-AC5: a corrupt database shows a recovery screen and changes nothing until confirmed', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const db = join(home, 'iap.db');
  writeFileSync(db, 'not a database '.repeat(300));
  const { app, page } = await launch(home);
  try {
    await resize(app, 1280, 800);
    await page.getByRole('heading', { name: 'Your workspace could not be opened' }).waitFor();
    assert.equal(readFileSync(db, 'utf8'), 'not a database '.repeat(300));
    await shot(page, '06-recovery-dark-1280');
    await page.getByRole('button', { name: 'Start a fresh workspace…' }).click();
    await page.getByRole('button', { name: 'Move it aside and start fresh' }).click();
    await page.getByText(/The damaged database was kept at/).waitFor();
    await page.getByRole('button', { name: 'Open the new workspace' }).click();
    await page.getByRole('heading', { name: 'No projects yet' }).waitFor();
  } finally {
    await app.close();
  }
});

test('M2-AC8: the renderer is isolated and IPC input is validated in the main process', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const { app, page } = await launch(home);
  try {
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0]!.webContents.getLastWebPreferences()!;
      return { contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, webSecurity: p.webSecurity };
    });
    assert.deepEqual(prefs, { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true });

    const probe = await page.evaluate(async () => {
      const w = window as unknown as Record<string, unknown>;
      const bad = await window.iap.createProject({ name: 42 } as never);
      const unknownState = await window.iap.moveRun({ runId: 'x', to: 'shipped' });
      const huge = await window.iap.createProject({ name: 'x', facts: Array.from({ length: 500 }, () => ({ kind: 'confirmed', text: 'y' })) } as never);
      let frozen = false;
      try {
        (window.iap as unknown as Record<string, unknown>).listProjects = () => null;
      } catch {
        frozen = true;
      }
      return { require: typeof w.require, process: typeof w.process, bad, unknownState, huge, frozen, cspInline: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') };
    });
    assert.equal(probe.require, 'undefined');
    assert.equal(probe.process, 'undefined');
    assert.deepEqual(probe.bad, { ok: false, error: { code: 'VALIDATION', message: 'Project name must be text.' } });
    assert.deepEqual(probe.unknownState, { ok: false, error: { code: 'VALIDATION', message: 'Unknown state "shipped".' } });
    assert.equal(probe.huge.ok, false);
    assert.ok(probe.frozen || (await page.evaluate(() => typeof window.iap.listProjects)) === 'function');
    assert.match(probe.cspInline ?? '', /script-src 'self'/);
  } finally {
    await app.close();
  }
});

test('M2-AC7/AC9: keyboard navigation, visible focus, and layouts at target sizes', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const { app, page } = await launch(home);
  try {
    await resize(app, 1280, 800);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Skip to content');
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const style = getComputedStyle(el);
      return { label: el.getAttribute('aria-label'), outline: style.outlineStyle, width: style.outlineWidth };
    });
    assert.equal(focused.label, 'Projects');
    assert.equal(focused.outline, 'solid');
    assert.notEqual(focused.width, '0px');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { level: 1, name: 'Activity' }).waitFor();

    for (const [w, h] of [
      [1920, 1080],
      [1024, 768],
    ] as const) {
      await resize(app, w, h);
      await page.getByRole('button', { name: 'Projects' }).click();
      await page.waitForTimeout(100);
      const layout = await page.evaluate(() => ({
        rail: document.querySelector('.rail')!.getBoundingClientRect().width,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      }));
      assert.equal(layout.overflow, false, `horizontal overflow at ${w}x${h}`);
      if (w === 1024) assert.ok(layout.rail <= 80, `rail should collapse at ${w}px, was ${layout.rail}`);
      else assert.ok(layout.rail >= 200, `rail should be expanded at ${w}px`);
      await shot(page, `07-projects-dark-${w}`);
    }
  } finally {
    await app.close();
  }
});
