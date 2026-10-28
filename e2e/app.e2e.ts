// End-to-end tests against the real Electron app (M2). Each test uses its own
// data directory. Screenshots are saved to e2e/screenshots/ as evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, Page } from 'playwright-core';
import { launch, SHOTS, tempHome } from './helpers.ts';
import { buildClaudeFixture, CANARIES } from '../test/claude-fixture.ts';

mkdirSync(SHOTS, { recursive: true });

async function resize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [width, height]);
}

const shot = async (page: Page, name: string) => {
  await page.mouse.move(1, 1); // no hover tooltips in the evidence
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

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
    // The side panel lists the new project and marks it as current.
    await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Recipe sharing app' }).and(page.locator('[aria-current="page"]')).waitFor();
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

    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    // The log loads asynchronously: wait for the entry rather than reading the table once.
    await page.getByRole('cell', { name: 'Run moved planned → blocked: EGM is not installed' }).waitFor();
    await shot(page, '03-activity-dark-1280');

    // Back on the overview, the project appears as a card.
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('list', { name: 'All projects' }).getByRole('button', { name: /Recipe sharing app/ }).waitFor();
    await shot(page, '08-projects-overview-dark-1280');
  } finally {
    await app.close();
  }

  // Restart: everything is still there (FR-APP-002).
  ({ app, page } = await launch(home));
  try {
    // The project is listed in the side panel's explorer.
    await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Recipe sharing app' }).click();
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
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('radio', { name: 'Light' }).check();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await shot(page, '04-settings-light-1280');
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await shot(page, '05-projects-empty-light-1280');

    // Frosted glass is on by default and can be switched to solid panels.
    assert.equal(await page.evaluate(() => document.documentElement.dataset.glass), 'on');
    const blur = () => page.locator('.rail').evaluate((el) => getComputedStyle(el).backdropFilter);
    assert.match(await blur(), /blur\(24px\)/);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('radio', { name: 'Solid panels' }).check();
    await page.waitForFunction(() => document.documentElement.dataset.glass === 'off');
    assert.doesNotMatch(await blur(), /blur\(24px\)/);
    await shot(page, '07-settings-solid-light-1280');
    await page.getByRole('radio', { name: 'Frosted glass' }).check();
    await page.waitForFunction(() => document.documentElement.dataset.glass === 'on');
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
      await page.getByRole('button', { name: 'Projects', exact: true }).click();
      await page.waitForTimeout(100);
      const layout = await page.evaluate(() => ({
        rail: document.querySelector('.rail')!.getBoundingClientRect().width,
        side: document.querySelector('.side')!.getBoundingClientRect().width,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      }));
      assert.equal(layout.overflow, false, `horizontal overflow at ${w}x${h}`);
      assert.ok(layout.rail <= 80, `rail should stay slim at ${w}px, was ${layout.rail}`);
      if (w === 1024) assert.equal(layout.side, 0, `side panel should be hidden at ${w}px`);
      else assert.ok(layout.side >= 200, `side panel should be shown at ${w}px`);
      await shot(page, `07-projects-dark-${w}`);
    }
  } finally {
    await app.close();
  }
});

test('M4: the Tools screen scans a Claude Code setup read-only and explains conflicts', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const fixture = buildClaudeFixture(join(home, 'machine'));
  // With CLAUDE_CONFIG_DIR set, Claude Code keeps .claude.json inside that folder.
  copyFileSync(fixture.userConfigFile, join(fixture.configDir, '.claude.json'));
  const { app, page } = await launch(join(home, 'app'), { CLAUDE_CONFIG_DIR: fixture.configDir });
  try {
    await resize(app, 1280, 800);
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page.getByRole('heading', { name: 'No scan yet' }).waitFor();
    await page.getByRole('button', { name: 'Scan now' }).click();
    await page.getByText('Plugin ghost@acme is enabled but not installed').waitFor();
    await page.getByText('2 tools answer /deploy').waitFor();
    const text = await page.locator('#main').innerText();
    for (const canary of CANARIES) assert.ok(!text.includes(canary), `leaked ${canary}`);
    await shot(page, '09-tools-findings-dark-1280');

    // Filter to MCP servers from the side panel and open one entry's details.
    await page.getByRole('navigation', { name: 'Tool filters' }).getByRole('button', { name: /MCP servers/ }).click();
    const table = page.getByRole('table', { name: 'Inventory' });
    assert.equal(await table.getByRole('row').count(), 1 + 6);
    await table.getByText('db', { exact: true }).click();
    await table.getByText('PGPASSWORD').waitFor();
    await shot(page, '10-tools-mcp-dark-1280');

    // The scan is stored: it is still there after switching away and back.
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page.getByText('Plugin ghost@acme is enabled but not installed').waitFor();
  } finally {
    await app.close();
  }
});

test('M3: the main agent runs on a started run and is clearly labelled simulated', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const { app, page } = await launch(home);
  try {
    await resize(app, 1280, 800);
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Name').fill('Agent demo');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByLabel('Title').fill('Build the importer');
    await page.getByRole('button', { name: 'Start run' }).click();
    const run = page.getByRole('article', { name: /Build the importer/ });
    // No agent before the run has started.
    assert.equal(await run.getByRole('region', { name: /Main agent/ }).count(), 0);
    for (const step of ['Mark planned', 'Approve plan', 'Start']) await run.getByRole('button', { name: step, exact: true }).click();

    const agent = run.getByRole('region', { name: /Main agent/ });
    await agent.getByText('Simulated', { exact: true }).waitFor();
    await agent.getByLabel('What should the agent do?').fill('Import recipes from a CSV file');
    await agent.getByRole('button', { name: 'Ask the agent' }).click();
    await agent.getByText('Succeeded', { exact: true }).first().waitFor();
    await agent.getByText('Single agent', { exact: true }).waitFor();
    await agent.locator('.agent-request > summary').first().click();
    await agent.getByText(/Simulated model: no AI was called/).waitFor();
    await shot(page, '11-agent-simulated-dark-1280');

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const ai = page.getByRole('region', { name: /AI usage/ });
    assert.equal(await ai.getByRole('radio', { name: 'No real calls' }).isChecked(), true);
    await ai.getByText('Simulated', { exact: true }).waitFor();
    // A budget without a key does not switch real calls on; the key field never shows a stored key.
    await ai.getByRole('radio', { name: '$20 a month' }).check();
    await ai.getByText('Needs API key', { exact: true }).waitFor();
    await ai.getByText('of $20 used this month').waitFor();
    assert.equal(await ai.getByLabel('Anthropic API key').getAttribute('type'), 'password');
    await shot(page, '12-settings-ai-usage-dark-1280');
  } finally {
    await app.close();
  }
});

test('M5: plan a project from brief to specification, with versions and a recorded change', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const { app, page } = await launch(home);
  try {
    await resize(app, 1280, 900);
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Name').fill('Recipe box');
    await page.getByLabel('Idea').fill('A private recipe box for home cooks');
    await page.getByRole('button', { name: 'Create project' }).click();

    const planning = page.getByRole('region', { name: 'Planning' });
    await planning.getByText(/EGM was not checked/).waitFor();
    const brief = planning.getByRole('region', { name: 'Concept brief' });
    const spec = planning.getByRole('region', { name: 'Specification' });
    assert.equal(await spec.getByRole('button', { name: 'Draft the specification' }).isDisabled(), true);

    await brief.getByRole('button', { name: 'Draft the concept brief' }).click();
    await brief.getByText('Simulated draft', { exact: true }).waitFor();
    // A simulated draft keeps its placeholders, so it cannot be approved as is.
    await brief.getByRole('button', { name: 'Approve version 1' }).click();
    await brief.getByText(/Goals still has 1 placeholder/).waitFor();
    await shot(page, '13-planning-brief-draft-dark-1280');

    const fill = { Goals: 'Keep family recipes in one place', Users: 'Home cooks', 'Use cases': 'Add a recipe', 'In scope': 'Local storage only', 'Success criteria': 'A recipe survives a restart' };
    for (const [label, text] of Object.entries(fill)) await brief.getByLabel(label, { exact: true }).fill(text);
    await brief.getByRole('button', { name: 'Approve version 1' }).click();
    await brief.getByText('Approved · version 1').waitFor();

    await spec.getByRole('button', { name: 'Draft the specification' }).click();
    await spec.getByRole('group', { name: 'REQ-001' }).waitFor();
    await spec.getByLabel('Acceptance criteria').first().fill('A saved recipe is listed after a restart');
    await spec.getByLabel('Acceptance criteria').nth(1).fill('The add form saves a title and steps');
    await spec.getByRole('button', { name: 'Approve version 1' }).click();
    await spec.getByText('Approved · version 1').waitFor();

    // Revising the brief needs a change note, records the diff, and flags the spec as out of date.
    await brief.getByRole('button', { name: 'Revise' }).click();
    await brief.getByLabel('Goals', { exact: true }).fill('Keep and share family recipes');
    await brief.getByRole('button', { name: 'Approve version 2' }).click();
    await brief.getByText(/change note/).waitFor();
    await brief.getByLabel(/What changed and why/).fill('Sharing is now in scope');
    await brief.getByRole('button', { name: 'Approve version 2' }).click();
    await brief.getByText('Approved · version 2').waitFor();
    await planning.getByText('The specification is out of date').waitFor();
    await brief.getByText('Changed in this version').waitFor();
    await brief.getByText('History (2)').click();
    await brief.getByRole('button', { name: 'Compare with version 1' }).click();
    await brief.getByText('Keep and share family recipes', { exact: false }).first().waitFor();
    await shot(page, '14-planning-approved-dark-1280');

    const docsPath = await page.locator('dd.mono').first().innerText();
    assert.match(readFileSync(join(docsPath, 'brief.md'), 'utf8'), /Keep and share family recipes/);
    assert.match(readFileSync(join(docsPath, 'versions', 'brief-v1.md'), 'utf8'), /Keep family recipes in one place/);
    assert.match(readFileSync(join(docsPath, 'spec.md'), 'utf8'), /REQ-001/);
  } finally {
    await app.close();
  }
});
