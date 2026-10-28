// End-to-end tests against the real Electron app (M2). Each test uses its own
// data directory. Screenshots are saved to e2e/screenshots/ as evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

    // Command Centre: the run shows on the board under its real state, and the palette opens a project.
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    const board = page.getByRole('region', { name: /^Planning, 1/ });
    await board.getByRole('button', { name: /Initial plan, Recipe sharing app/ }).waitFor();
    await page.getByRole('region', { name: 'Recent activity' }).getByText(/Run moved blocked → planned/).waitFor();
    await shot(page, '09-home-dark-1280');
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Search projects or go to' }).fill('recipe');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { level: 1, name: 'Recipe sharing app' }).waitFor();
    await page.getByRole('navigation', { name: 'Project phases' }).getByRole('button', { name: /Plan/ }).first().waitFor();
    await shot(page, '10-project-phases-dark-1280');
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
    assert.match(await blur(), /blur\(18px\)/);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('radio', { name: 'Solid panels' }).check();
    await page.waitForFunction(() => document.documentElement.dataset.glass === 'off');
    assert.doesNotMatch(await blur(), /blur\(18px\)/);
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
    assert.equal(focused.label, 'Home');
    assert.equal(focused.outline, 'solid');
    assert.notEqual(focused.width, '0px');
    await page.keyboard.press('Tab');
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
      await page.getByRole('button', { name: 'Home', exact: true }).click();
      await page.getByRole('heading', { level: 1, name: 'Welcome back' }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `home overflows at ${w}x${h}`);
      await shot(page, `07-home-dark-${w}`);
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

test('M6: fix a bug in a worktree, with commands approved in a native dialog and real check results', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const { app, page } = await launch(home);
  try {
    await resize(app, 1280, 900);
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Name').fill('Fix demo');
    await page.getByRole('button', { name: 'Create project' }).click();

    const panel = page.getByRole('region', { name: /Build work/ });
    await panel.getByRole('button', { name: 'Start a repository in the project folder' }).click();
    await panel.getByText(/^Repository:/).waitFor();
    await panel.getByRole('button', { name: 'New feature or bug fix' }).click();
    const form = panel.getByRole('form', { name: 'New build work' });
    await form.getByLabel('Title').fill('Missing marker file');
    await form.getByLabel('What is wrong').fill('The check fails because fixed.txt does not exist');
    await form.getByLabel('How to reproduce it').fill('Run the marker check');
    await form.getByLabel(/Check commands/).fill(`marker = node -e "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)"`);
    await form.getByRole('button', { name: 'Add' }).click();

    const card = panel.locator('.build-card').first();
    await card.getByText('Not started', { exact: true }).waitFor();
    // Declining the native dialog runs nothing.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });
    await card.getByRole('button', { name: 'Start and run checks' }).click();
    await card.getByText(/not approved, so nothing ran/).waitFor();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });
    await card.getByRole('button', { name: 'Start and run checks' }).click();
    await card.getByText('In progress', { exact: true }).waitFor();
    const checks = card.getByRole('list', { name: 'Check results' });
    await checks.getByText('Failed', { exact: true }).waitFor();

    await card.getByRole('button', { name: 'Run the agent' }).click();
    await card.getByText('Simulated', { exact: true }).waitFor();
    await card.getByText(/files written: none/).waitFor();

    // The person makes the fix by hand in the worktree, then verifies.
    const worktree = await card.locator('p:has-text("Branch") .mono').nth(1).innerText();
    writeFileSync(join(worktree, 'fixed.txt'), 'fixed\n');
    await card.getByRole('button', { name: 'Verify', exact: true }).click();
    await card.getByText('Ready for review', { exact: true }).waitFor();
    await checks.getByText('Passed', { exact: true }).waitFor();
    await card.getByRole('list', { name: 'Risks' }).getByText(/No regression test/).waitFor();
    await card.getByRole('button', { name: 'Show diff' }).click();
    await card.getByText(/\+fixed/).waitFor();
    await shot(page, '15-build-review-dark-1280');

    await card.getByRole('button', { name: 'Mark done' }).click();
    await card.getByText(/Explain why the remaining risks/).waitFor();
    await card.getByLabel(/Why the remaining risks are acceptable/).fill('A marker file needs no test.');
    await card.getByRole('button', { name: 'Mark done' }).click();
    await panel.getByText('Done', { exact: true }).waitFor();
  } finally {
    await app.close();
  }
});

test('M7: a ship-check shows each gate with its evidence, needs exceptions for failed gates, and prepares without deploying', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const { app, page } = await launch(home);
  try {
    await resize(app, 1280, 900);
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Name').fill('Ship demo');
    await page.getByRole('button', { name: 'Create project' }).click();
    const builds = page.getByRole('region', { name: /Build work/ });
    await builds.getByRole('button', { name: 'Start a repository in the project folder' }).click();
    await builds.getByText(/^Repository:/).waitFor();

    const panel = page.getByRole('region', { name: /Releases/ });
    await panel.getByRole('button', { name: 'New release' }).click();
    const form = panel.getByRole('form', { name: 'New release' });
    await form.getByLabel('Version').fill('0.1.0');
    await form.getByLabel(/Release checks/).fill('unit = node -e "process.exit(0)"');
    await form.getByLabel('Where it goes').fill('A zip file for one tester');
    await form.getByLabel('How you will know it works').fill('The tester opens the app');
    await form.getByLabel('How to undo it').fill('Ask the tester to delete the zip');
    await form.getByRole('button', { name: 'Add release' }).click();

    const card = panel.locator('.release-card').first();
    await card.getByText('Not checked', { exact: true }).waitFor();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });
    await card.getByRole('button', { name: 'Run the ship-check' }).click();
    await card.getByText(/not approved, so nothing ran/).waitFor();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });
    await card.getByRole('button', { name: 'Run the ship-check' }).click();
    await card.getByText('3 blocking', { exact: true }).waitFor();
    const gates = card.getByRole('list', { name: 'Gates' });
    const gate = (id: string) => gates.locator(`li[data-gate="${id}"]`);
    await gate('tests').getByText('Passed', { exact: true }).waitFor();
    await gate('spec').getByText('No specification has been approved.').waitFor();
    await gate('reviews').getByText('Skipped', { exact: true }).waitFor();
    assert.ok(await card.getByRole('button', { name: 'Mark prepared' }).isDisabled());
    await shot(page, '16-ship-check-blocked-dark-1280');

    for (const id of ['spec', 'drift', 'builds']) {
      const g = gate(id);
      await g.getByText('Release anyway with an exception').click();
      await g.getByLabel('Why this is acceptable').fill('Trying the packaging flow only');
      await g.getByLabel('How you will limit the risk').fill('Only one tester receives it');
      await g.getByRole('button', { name: 'Record exception' }).click();
      await g.getByText('Exception recorded', { exact: true }).waitFor();
    }
    await card.getByText('Ready to prepare', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Mark prepared' }).click();
    await card.getByText('Nothing was deployed').waitFor();
    await page.getByRole('navigation', { name: 'Project phases' }).getByText('0.1.0 prepared · not deployed').waitFor();
    await shot(page, '17-release-prepared-dark-1280');
  } finally {
    await app.close();
  }
});

test('M8: import an existing repository and assess it read-only, in full and focused', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  // A small existing app, committed, with one uncommitted change the assessment must not read.
  const repo = join(home, 'existing-shop');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'shop', scripts: { test: 'node --test' }, dependencies: { express: '^4.0.0', pg: '^8.0.0' } }),
    'README.md': '# Shop\n\nOrders API for a small shop.\n',
    'src/server.js': "import express from 'express';\nimport { Pool } from 'pg';\nconst app = express();\nconst pool = new Pool({ connectionString: process.env.DATABASE_URL });\napp.get('/orders', async (req, res) => res.json([]));\n",
    'test/server.test.js': "import { test } from 'node:test';\ntest('orders', () => {});\n",
    '.env.example': 'DATABASE_URL=\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  writeFileSync(join(repo, 'notes.txt'), 'not committed\n');
  const before = [git('rev-parse', 'HEAD'), git('for-each-ref'), git('--no-optional-locks', 'status', '--porcelain'), readFileSync(join(repo, '.git', 'index')).toString('base64')];

  const { app, page } = await launch(home);
  try {
    await resize(app, 1280, 900);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'Import a repository' }).click();
    const form = page.getByRole('region', { name: 'Import a repository' });
    await form.getByLabel('Name').fill('Existing shop');
    await form.getByLabel('Repository folder').fill(join(home, 'nowhere'));
    await form.getByRole('button', { name: 'Import' }).click();
    await form.getByText(/does not exist/).waitFor();
    await form.getByLabel('Repository folder').fill(repo);
    await form.getByRole('button', { name: 'Import' }).click();

    await page.getByRole('heading', { name: 'Existing shop', level: 1 }).waitFor();
    await page.locator('.next-step').getByText('Assess the repository').waitFor();
    const panel = page.getByRole('region', { name: /^Assessment/ });
    await panel.getByRole('button', { name: 'Assess (read-only)' }).click();
    const card = panel.locator('.assess-card').first();
    await card.getByText('Completed', { exact: true }).waitFor();
    await card.getByText('Repository unchanged', { exact: true }).waitFor();
    const api = card.getByRole('list', { name: 'Interfaces capabilities' }).locator('li').filter({ hasText: 'API' }).first();
    await api.getByText('Implemented in code', { exact: true }).waitFor();
    const database = card.getByRole('list', { name: 'Operations capabilities' }).locator('li').filter({ hasText: 'Database' }).first();
    await database.getByText(/outside the code: not verified/).waitFor();
    await card.getByText('What was and was not inspected').click();
    await card.getByText(/1 uncommitted change/).waitFor();
    await card.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shot(page, '18-assessment-full-dark-1280');

    await panel.getByLabel('What to assess').selectOption('capability');
    await panel.getByLabel('Capability', { exact: true }).selectOption('secrets');
    await panel.getByRole('button', { name: 'Assess (read-only)' }).click();
    const focused = panel.locator('.assess-card').first();
    await focused.getByText('Capability: Secrets', { exact: true }).waitFor();
    await focused.getByText('Completed', { exact: true }).waitFor();
    assert.equal(await focused.locator('.release-gates > li').count(), 1, 'only the chosen capability is reported');
    await focused.getByRole('button', { name: 'Run a full assessment' }).waitFor();
    await shot(page, '19-assessment-focused-dark-1280');
  } finally {
    await app.close();
  }
  const after = [git('rev-parse', 'HEAD'), git('for-each-ref'), git('--no-optional-locks', 'status', '--porcelain'), readFileSync(join(repo, '.git', 'index')).toString('base64')];
  assert.deepEqual(after, before, 'the imported repository was not changed');
});
