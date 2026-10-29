// End-to-end tests against the real Electron app (M2). Each test uses its own
// data directory. Screenshots are saved to e2e/screenshots/ as evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, Page } from 'playwright-core';
import { contrastFailures, launch, ROOT, SHOTS, tempHome } from './helpers.ts';
import { buildClaudeFixture, CANARIES } from '../test/claude-fixture.ts';
import { platformRepo, solidPng } from '../test/helpers.ts';

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
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('heading', { name: 'No projects yet' }).waitFor();
    await shot(page, '01-projects-empty-dark-1280');

    await page.getByRole('button', { name: 'Projects', exact: true }).click();

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

    // The run tracker is optional and folded away until opened.
    await page.getByText('Run tracker (optional)').click();
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

    await page.getByRole('button', { name: 'Settings', exact: true }).click();

    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    // The log loads asynchronously: wait for the entry rather than reading the table once.
    await page.getByRole('cell', { name: 'Run moved planned → blocked: EGM is not installed' }).waitFor();
    await shot(page, '03-activity-dark-1280');

    // Back on the overview, the project appears as a card.
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('list', { name: 'All projects' }).getByRole('button', { name: /Recipe sharing app/ }).waitFor();
    await shot(page, '08-projects-overview-dark-1280');

    // Build (M15): the home is the task composer and the person's work, and the palette opens a project.
    await page.getByRole('button', { name: 'Build', exact: true }).click();
    await page.getByRole('form', { name: 'Start a task' }).getByLabel('What do you want to build?').waitFor();
    assert.equal(await page.getByRole('combobox', { name: 'Project' }).inputValue() !== '', true);
    // With no work yet, Build greets with examples; one fills the message bar. There is no side panel here.
    await page.getByRole('heading', { name: 'What do you want to build?' }).waitFor();
    assert.equal(await page.locator('.side').count(), 0);
    await page.getByRole('button', { name: 'Fix the crash when the rota is empty' }).click();
    assert.equal(await page.getByRole('textbox', { name: 'What do you want to build?' }).inputValue(), 'Fix the crash when the rota is empty');
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
    // The project is listed in the side panel's explorer (shown under Projects; Build has no side panel).
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Recipe sharing app' }).click();
    await page.getByText('Run tracker (optional)').click();
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
    // The day sky is the default (M16); the night sky is one click away.
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await shot(page, '04-settings-light-1280');
    await page.getByRole('radio', { name: 'Dark' }).check();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await shot(page, '04-settings-night-1280');
    await page.getByRole('radio', { name: 'Light' }).check();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await shot(page, '05-projects-empty-light-1280');

    // Frosted glass is on by default and can be switched to solid panels.
    assert.equal(await page.evaluate(() => document.documentElement.dataset.glass), 'on');
    // The window over the sky is the frosted layer (DEC-035).
    const blur = () => page.locator('.shell').evaluate((el) => getComputedStyle(el).backdropFilter);
    assert.match(await blur(), /blur\(32px\)/);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('radio', { name: 'Solid panels' }).check();
    await page.waitForFunction(() => document.documentElement.dataset.glass === 'off');
    assert.doesNotMatch(await blur(), /blur\(32px\)/);
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
    await page.getByRole('textbox', { name: 'What do you want to build?' }).waitFor();
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
    assert.equal(focused.label, 'Build');
    assert.equal(focused.outline, 'solid');
    assert.notEqual(focused.width, '0px');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.getByRole('navigation', { name: 'Library sections' }).getByRole('button', { name: 'Learning Studio' }).and(page.locator('[aria-current="page"]')).waitFor();

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
      await page.getByRole('button', { name: 'Build', exact: true }).click();
      await page.getByRole('heading', { name: 'What do you want to build?' }).or(page.getByText('What do you want to build?')).first().waitFor();
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
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
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
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
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
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Name').fill('Agent demo');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByText('Run tracker (optional)').click();
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
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
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
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Name').fill('Fix demo');
    await page.getByRole('button', { name: 'Create project' }).click();

    const panel = page.getByRole('region', { name: /Build work/ });
    await panel.getByRole('button', { name: 'Start a repository in the project folder' }).click();
    await panel.getByText(/^Repository:/).waitFor();
    await panel.getByRole('button', { name: 'New feature, bug fix or UI polish' }).click();
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
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
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

test('M9: collect design references in the Learning Studio, with a suggestion that is only applied when accepted', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const incoming = join(home, 'Downloads');
  mkdirSync(incoming);
  const files = {
    'onboarding-welcome.png': solidPng(480, 300, [124, 92, 255], [32, 22, 74]),
    'pricing_cards.png': solidPng(480, 300, [83, 222, 216], [10, 60, 70]),
    'settings-dark.png': solidPng(300, 480, [40, 46, 70], [12, 14, 24]),
    'logo.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  };
  for (const [name, data] of Object.entries(files)) writeFileSync(join(incoming, name), data);
  const picked = Object.keys(files).map((n) => join(incoming, n));

  const { app, page } = await launch(home);
  try {
    await resize(app, 1280, 900);
    await page.evaluate(() => window.iap.createProject({ name: 'Club HR' }));
    await page.reload();
    await page.waitForSelector('#main');
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('button', { name: 'Learning Studio' }).click();
    await page.getByRole('heading', { name: 'No references yet' }).waitFor();

    // The page never supplies a path: files come from the native picker, stubbed here.
    await app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: paths })) as typeof dialog.showOpenDialog;
    }, picked);
    await page.getByRole('button', { name: 'Add files' }).first().click();
    await page.getByText('Added 3 files, skipped 1').waitFor();
    await page.getByText(/logo\.svg.*SVG is not accepted/).waitFor();
    const grid = page.getByRole('list', { name: 'References' });
    assert.equal(await grid.getByRole('listitem').count(), 3);
    // Previews are served from the app's own copies through the iap-ref: scheme.
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.ref-grid img')].every((i) => i.complete && i.naturalWidth > 0));
    const unknown = await page.evaluate(
      () =>
        new Promise<number>((done) => {
          const img = new Image();
          img.onload = () => done(img.naturalWidth);
          img.onerror = () => done(-1);
          img.src = 'iap-ref://ref/ref_00000000-0000-0000-0000-000000000000';
        }),
    );
    assert.equal(unknown, -1, 'an unknown id is not served');

    await grid.getByRole('button', { name: /onboarding welcome/ }).click();
    const inspector = page.getByRole('region', { name: 'onboarding welcome' });
    await inspector.getByRole('button', { name: 'Suggest (simulated)' }).click();
    await inspector.getByText('Waiting for you').waitFor();
    await inspector.getByText('Simulated: no AI looked at this file.').waitFor();
    assert.equal(await inspector.getByLabel('Kind').inputValue(), 'other', 'nothing is applied before accepting');
    await inspector.getByRole('button', { name: 'Accept suggestion' }).click();
    await inspector.getByText('Accepted', { exact: true }).waitFor();
    assert.match(await inspector.getByLabel('Tags').inputValue(), /onboarding/);

    await inspector.getByLabel('Title').fill('Onboarding welcome');
    await inspector.getByLabel('Kind').selectOption('ui_design');
    await inspector.getByLabel('Tags').fill('onboarding, empty-state, illustration');
    await inspector.getByLabel('Project').selectOption({ label: 'Club HR' });
    await inspector.getByLabel('Your notes').fill('Borrow the warm welcome and single clear action. Not the colours.');
    await inspector.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('region', { name: 'Onboarding welcome' }).getByText('You corrected it').waitFor();

    await grid.getByRole('button', { name: /pricing cards/ }).click();
    const pricing = page.getByRole('region', { name: 'pricing cards' });
    await pricing.getByLabel('Tags').fill('pricing, cards');
    await pricing.getByRole('button', { name: 'Save' }).click();
    await pricing.getByText('Saved.').waitFor();
    await pricing.getByRole('button', { name: 'Close the reference' }).click();

    await page.getByRole('group', { name: 'Group by' }).getByRole('button', { name: 'Project' }).click();
    await page.getByRole('heading', { name: /Club HR/ }).waitFor();
    await page.getByRole('heading', { name: /Not linked to a project/ }).waitFor();
    await page.getByRole('group', { name: 'Group by' }).getByRole('button', { name: 'Tag' }).click();
    await page.getByRole('heading', { name: /#onboarding/ }).waitFor();
    await shot(page, '20-learning-studio-library-dark-1280');

    await page.getByLabel('Search references').fill('warm welcome');
    await page.getByRole('group', { name: 'Group by' }).getByRole('button', { name: 'No groups' }).click();
    await grid.getByRole('button', { name: /pricing cards/ }).waitFor({ state: 'detached' });
    assert.equal(await grid.getByRole('listitem').count(), 1);
    await grid.getByRole('button', { name: /Onboarding welcome/ }).click();
    await page.getByRole('region', { name: 'Onboarding welcome' }).waitFor();
    await shot(page, '21-learning-studio-reference-dark-1280');

    // Archive hides it; it is never deleted and can be restored.
    await page.getByRole('region', { name: 'Onboarding welcome' }).getByRole('button', { name: 'Archive' }).click();
    await page.getByRole('heading', { name: 'Nothing matches' }).waitFor();
    await page.getByLabel('Search references').fill('');
    await page.getByRole('navigation', { name: 'Reference filters' }).getByRole('button', { name: 'Archived' }).click();
    await page.getByRole('heading', { name: 'Nothing matches' }).waitFor({ state: 'detached' });
    await grid.getByRole('button', { name: /pricing cards/ }).waitFor({ state: 'detached' });
    assert.equal(await grid.getByRole('listitem').count(), 1);

  } finally {
    await app.close();
  }
  for (const [name, data] of Object.entries(files)) assert.deepEqual(readFileSync(join(incoming, name)), data, `${name} was left as it was`);
});

test('M9: polish the UI with an audit of the design system, a chosen reference and design checks in the review', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const repo = join(home, 'club-hr');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'club-hr', dependencies: { react: '^18.3.0' } }),
    'src/styles/tokens.css': ':root {\n  --bg: #0b1020;\n  --text: #f4f6fc;\n  --accent: #8b6cff;\n  --radius: 12px;\n}\n',
    'src/styles/app.css': '.card { background: var(--bg); border-radius: var(--radius); }\n@media (max-width: 1060px) { .side { display: none; } }\n',
    'src/components/Card.jsx': 'export function Card({ children }) {\n  return <div className="card">{children}</div>;\n}\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const shotFile = join(home, 'calm-cards.png');
  writeFileSync(shotFile, solidPng(320, 200, [139, 108, 255], [20, 16, 50]));

  const { app, page } = await launch(home);
  try {
    await resize(app, 1280, 900);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'Import a repository' }).click();
    const form = page.getByRole('region', { name: 'Import a repository' });
    await form.getByLabel('Name').fill('Club HR');
    await form.getByLabel('Repository folder').fill(repo);
    await form.getByRole('button', { name: 'Import' }).click();
    await page.getByRole('heading', { name: 'Club HR', level: 1 }).waitFor();

    await page.getByRole('button', { name: 'Library', exact: true }).click();

    await page.getByRole('button', { name: 'Learning Studio' }).click();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, shotFile);
    await page.getByRole('button', { name: 'Add files' }).first().click();
    await page.getByText('Added 1 file').waitFor();

    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: /Club HR/ }).first().click();
    const panel = page.getByRole('region', { name: /Build work/ });
    await panel.getByRole('button', { name: 'New feature, bug fix or UI polish' }).click();
    const build = panel.getByRole('form', { name: 'New build work' });
    await build.getByLabel('Polish the UI').check();
    await build.getByLabel('Title').fill('Calmer cards');
    await build.getByLabel('What to improve').fill('Cards feel heavy; make them calmer and lift them on hover');
    await build.getByRole('list', { name: 'References' }).getByLabel(/calm cards/).check();
    await build.getByLabel('Animation is part of this work').check();
    await build.getByLabel(/Check commands/).fill('unit = node -e "process.exit(0)"');
    await build.getByRole('button', { name: 'Add' }).click();

    const card = panel.locator('.build-card').first();
    await card.getByText('UI polish', { exact: true }).waitFor();
    await card.getByText('The design system is audited when the work starts.').waitFor();
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });
    await card.getByRole('button', { name: 'Start and run checks' }).click();
    const audit = card.getByRole('definition').filter({ hasText: /^4/ });
    await card.getByText('UI audit (before any change)').waitFor();
    await audit.first().waitFor();
    await card.getByText('Not handled anywhere').waitFor();
    await card.getByText(/Motion asked for: yes · References: 1/).waitFor();

    // The person changes the worktree by hand, with two slips the review should catch.
    const worktree = await card.locator('p:has-text("Branch") .mono').nth(1).innerText();
    writeFileSync(join(worktree, 'src', 'styles', 'app.css'), files['src/styles/app.css'] + '.card:hover { border-color: #ff3366; transition: height 200ms; }\n');
    await card.getByRole('button', { name: 'Verify', exact: true }).click();
    await card.getByText('Ready for review', { exact: true }).waitFor();
    const risks = card.getByRole('list', { name: 'Risks' });
    await risks.getByText('off token value').waitFor();
    await risks.getByText('motion reduced').waitFor();
    await risks.getByText('motion performance').waitFor();
    await risks.getByText('manual check').waitFor();
    await card.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shot(page, '22-ui-polish-review-dark-1280');
  } finally {
    await app.close();
  }
  assert.equal(readFileSync(join(repo, 'src', 'styles', 'app.css'), 'utf8'), files['src/styles/app.css'], 'the checkout is untouched');
});

test('M10: the app assesses its own records in three layers, and the person moves backlog items through approval to release', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const { app, page } = await launch(home);
  try {
    await resize(app, 1280, 900);
    // Two plan runs blocked for the same reason: the kind of trouble a self-assessment should find.
    await page.evaluate(async () => {
      const p = await window.iap.createProject({ name: 'Club HR' });
      if (!p.ok) throw new Error(p.error.message);
      for (const title of ['Plan payroll', 'Plan rota']) {
        const r = await window.iap.startRun({ projectId: p.value.id, workflow: 'plan', title });
        if (!r.ok) throw new Error(r.error.message);
        await window.iap.moveRun({ runId: r.value.id, to: 'planned' });
        await window.iap.moveRun({ runId: r.value.id, to: 'blocked', reason: 'Waiting on the club secretary', resolution: 'Ask the secretary' });
      }
    });
    await page.reload();
    await page.waitForSelector('#main');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Improvements', exact: true }).first().click();
    await page.getByRole('heading', { name: 'The backlog is empty' }).waitFor();

    await page.getByRole('button', { name: 'Run self-assessment' }).click();
    const findings = page.getByRole('table', { name: 'Findings' });
    await findings.getByText('2 plan runs are blocked.').waitFor();
    await findings.getByText(/They share one reason: “Waiting on the club secretary”/).waitFor();
    await findings.getByText('high confidence').waitFor();
    await findings.getByText('Fewer blocked plan runs').waitFor();
    await page.getByText('App crashes and unexpected errors are not logged, so they cannot be counted.').waitFor();
    const list = page.getByRole('list', { name: 'Improvements' });
    assert.equal(await list.getByRole('listitem').count(), 1);

    // Running it again with nothing new adds nothing.
    await page.getByRole('button', { name: 'Run self-assessment' }).click();
    await page.getByText('0 new items, 0 with new evidence.').waitFor();
    assert.equal(await list.getByRole('listitem').count(), 1);

    // Typed feedback becomes an idea.
    await page.getByLabel('What should work better?').fill('Show how long checks usually take on the build screen');
    await page.getByRole('button', { name: 'Add idea' }).click();
    await list.getByText('Show how long checks usually take on the build screen').waitFor();
    await page.getByRole('button', { name: 'Close the item' }).click();
    await page.locator('.content').evaluate((el) => el.scrollTo(0, 0));
    await shot(page, '23-improvements-self-assessment-dark-1280');

    // Approve the finding's item, then take it to release with a result and a measured outcome.
    await list.getByRole('button', { name: /Fewer blocked plan runs/ }).click();
    const inspector = page.getByRole('region', { name: /IMP-1 Fewer blocked plan runs/ });
    await inspector.getByText('Approving records your decision. It does not change the app.').waitFor();
    await inspector.getByRole('button', { name: 'Approve' }).click();
    await inspector.getByText(/^by .+ on /).waitFor();
    await inspector.getByRole('button', { name: 'Start work' }).click();
    await inspector.getByRole('button', { name: 'Mark verified' }).click();
    await inspector.getByLabel('Result').fill('Plans now name who to ask; checked on Club HR');
    await inspector.getByRole('button', { name: 'Mark verified' }).last().click();
    await inspector.getByText('Verified', { exact: true }).waitFor();
    await inspector.getByRole('button', { name: 'Mark released' }).click();
    await inspector.getByLabel('Measured outcome').fill('No blocked plan runs in the two weeks after release');
    await inspector.getByRole('button', { name: 'Mark released' }).last().click();
    await inspector.getByText('Released', { exact: true }).waitFor();
    await inspector.getByTestId('recurrence').getByText(/Run a self-assessment after approval/).waitFor();
    await page.getByRole('button', { name: 'Run self-assessment' }).click();
    await inspector.getByTestId('recurrence').getByText(/0 since approval/).waitFor();
    await shot(page, '24-improvements-released-dark-1280');
  } finally {
    await app.close();
  }
});

test('M11: resolve tool conflicts with a dry run, a native approval, a verified result and a restore', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const fixture = buildClaudeFixture(join(home, 'machine'));
  copyFileSync(fixture.userConfigFile, join(fixture.configDir, '.claude.json'));
  const log = join(home, 'claude-calls.jsonl');
  writeFileSync(log, '');
  const fake = join(ROOT, 'test', 'fake-claude.mjs');
  const { app, page } = await launch(join(home, 'app'), {
    CLAUDE_CONFIG_DIR: fixture.configDir,
    // A stand-in for Claude Code's claude command, run with Electron's own Node.
    IAP_CLAUDE_COMMAND: JSON.stringify([process.execPath, fake]),
    FAKE_CLAUDE_CONFIG: fixture.configDir,
    FAKE_CLAUDE_USER_FILE: join(fixture.configDir, '.claude.json'),
    FAKE_CLAUDE_LOG: log,
  });
  try {
    await resize(app, 1280, 900);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page.getByRole('button', { name: 'Scan now' }).click();
    const finding = page.locator('details.finding', { hasText: '2 tools answer /deploy' });
    await finding.waitFor();

    // A personal skill that overlaps a project one: moved aside after approval, then restored.
    await finding.getByRole('button', { name: /\/deploy · Personal/ }).click();
    const panel = page.getByRole('region', { name: 'Resolve /deploy' });
    const options = panel.getByRole('list', { name: 'Ways to resolve it' });
    await options.getByRole('button', { name: /Uninstall it/ }).waitFor(); // the options load after the panel opens
    assert.deepEqual(
      (await options.locator('.run-tile-title').allInnerTexts()).map((s) => s.trim()),
      ['Keep both', 'Change the configuration', 'Move it aside (can be undone)', 'Use /deploy instead', 'Uninstall it'],
    );
    await options.getByRole('button', { name: /Move it aside/ }).click();
    await panel.getByText('Dry run: nothing has changed.').waitFor();
    assert.ok(existsSync(join(fixture.configDir, 'skills', 'deploy', 'SKILL.md')), 'a dry run changes nothing');

    // Refused in the native dialog: nothing changes.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });
    await panel.getByRole('button', { name: 'Make this change…' }).click();
    await panel.getByText('Not approved. Nothing was changed.').waitFor();
    assert.ok(existsSync(join(fixture.configDir, 'skills', 'deploy', 'SKILL.md')));

    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });
    await panel.getByLabel('Reason (kept in the audit log)').fill('The project version should win');
    await panel.getByRole('button', { name: 'Make this change…' }).click();
    await panel.getByText(/Done: The file is in the backup folder/).waitFor();
    assert.ok(!existsSync(join(fixture.configDir, 'skills', 'deploy')));
    await panel.getByRole('button', { name: 'Restore…' }).click();
    await panel.getByText(/Restored: It is back in place/).waitFor();
    assert.ok(existsSync(join(fixture.configDir, 'skills', 'deploy', 'SKILL.md')));
    await panel.getByRole('button', { name: 'Close the cleanup' }).click();

    // A plugin: Claude Code's own disable command, after accepting what depends on it.
    const table = page.getByRole('table', { name: 'Inventory' });
    const row = table.locator('tr', { hasText: 'review-kit@acme' }).filter({ hasText: 'Personal' }).first();
    await row.locator('summary').click();
    await row.getByRole('button', { name: 'Resolve or remove…' }).click();
    const pluginPanel = page.getByRole('region', { name: 'Resolve review-kit@acme' });
    await pluginPanel.getByRole('button', { name: /Disable it/ }).click();
    await pluginPanel.getByText('claude plugin disable review-kit@acme --scope user').waitFor();
    await pluginPanel.getByText(/Claude Code refuses if another enabled plugin depends on this one/).waitFor();
    const go = pluginPanel.getByRole('button', { name: 'Make this change…' });
    assert.equal(await go.isDisabled(), true, 'dependents must be accepted first');
    await pluginPanel.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shot(page, '25-tools-cleanup-dry-run-dark-1280');
    await pluginPanel.getByLabel(/I accept that the tools and workflows/).check();
    await go.click();
    await pluginPanel.getByText(/Done: The user settings now disable review-kit@acme/).waitFor();
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).args.join(' '));
    assert.deepEqual(calls, ['plugin disable review-kit@acme --scope user']);
    const history = page.getByRole('list', { name: 'Cleanup plans' });
    await history.getByText('disable review-kit@acme', { exact: true }).waitFor();
    await history.getByText('disable /deploy', { exact: true }).waitFor();
    await pluginPanel.getByRole('button', { name: 'Close the cleanup' }).click();
    await history.locator('summary').first().click();
    await history.evaluate((el) => el.closest('section')!.scrollIntoView({ block: 'start' }));
    await shot(page, '26-tools-cleanup-history-dark-1280');
  } finally {
    await app.close();
  }
});

test('M12: check trusted sources for updates, approve one, see it installed by the next check, and verify it', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const fixture = buildClaudeFixture(join(home, 'machine'));
  const versionFile = join(home, 'claude-version.txt');
  writeFileSync(versionFile, '2.0.0');
  const sources = join(home, 'sources.json');
  const npm = 'https://registry.npmjs.org/';
  writeFileSync(
    sources,
    JSON.stringify({
      [`${npm}@anthropic-ai%2fclaude-code/latest`]: { json: { version: '2.1.0' } },
      'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md': { text: '## 2.1.0\n\n- Added plugin update notes\n- Fixed a crash\n\n## 2.0.0\n\n- Old\n' },
      [`${npm}@anthropic-ai%2fsdk/latest`]: { json: { version: '1.3.0' } },
      [`${npm}react/latest`]: { json: { version: '18.3.1' } },
      [`${npm}react-dom/latest`]: { json: { version: '18.3.1' } },
      [`${npm}-/npm/v1/security/advisories/bulk`]: { json: {} },
      'https://raw.githubusercontent.com/acme/plugins/HEAD/.claude-plugin/marketplace.json': { json: { plugins: [{ name: 'review-kit', version: '1.3.0' }] } },
    }),
  );
  const { app, page } = await launch(join(home, 'app'), {
    CLAUDE_CONFIG_DIR: fixture.configDir,
    IAP_CLAUDE_COMMAND: JSON.stringify([process.execPath, join(ROOT, 'test', 'fake-claude.mjs')]),
    FAKE_CLAUDE_VERSION_FILE: versionFile,
    // Every source answers from this file; electron is left out, so it is unreachable.
    IAP_UPDATE_FIXTURE: sources,
  });
  try {
    await resize(app, 1280, 900);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page.getByRole('button', { name: 'Scan now' }).click();
    await page.locator('details.finding').first().waitFor();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();

    await page.getByRole('button', { name: 'Updates', exact: true }).first().click();
    await page.getByRole('heading', { name: 'No check yet' }).waitFor();
    await page.getByRole('button', { name: 'Check for updates' }).click();
    const table = page.getByRole('table', { name: 'Sources' });
    await table.waitFor();
    await table.locator('tr', { hasText: 'npm registry: electron' }).getByText('Unreachable').waitFor();
    await table.locator('tr', { hasText: 'Anthropic model list' }).getByText('Not checked').waitFor();
    await page.getByText(/Some sources have not answered recently/).waitFor();
    const list = page.getByRole('list', { name: 'Updates' });
    await list.getByText('review-kit@acme 1.3.0 is available (user install)').waitFor();

    await list.getByRole('button', { name: /Claude Code 2\.1\.0 is available/ }).click();
    const inspector = page.getByRole('complementary', { name: 'Update details panel' });
    await inspector.getByText('Added plugin update notes').waitFor();
    await inspector.getByText(/run claude update in a terminal/).waitFor();
    await inspector.getByText(/Tool cleanup: runs claude plugin and claude mcp/).waitFor();
    await page.getByRole('heading', { level: 1, name: /Watch for updates/ }).scrollIntoViewIfNeeded();
    await shot(page, '27-updates-found-dark-1280');

    await inspector.getByLabel('Note (optional, kept with your approval)').fill('Want the plugin fixes');
    await inspector.getByRole('button', { name: 'Approve' }).click();
    await inspector.getByText(/Approved by .*: Want the plugin fixes/).waitFor();
    assert.equal(readFileSync(versionFile, 'utf8'), '2.0.0', 'approving installs nothing');

    // The person updates Claude Code outside the app; the next check sees it.
    writeFileSync(versionFile, '2.1.0');
    await page.getByRole('button', { name: 'Check for updates' }).click();
    await inspector.getByText(/Installed, seen by the check on/).waitFor();
    await inspector.getByText('Claude Code 2.1.0 is installed.').waitFor();
    await inspector.getByRole('button', { name: 'Verify' }).click();
    await inspector.getByText('Version 2.1.0 is in place (wanted 2.1.0 or later).').waitFor();
    await inspector.getByText(/fresh tool scan finished/).waitFor();
    await list.getByRole('button', { name: /Claude Code 2\.1\.0/ }).getByText('Verified').waitFor();
    await shot(page, '28-updates-verified-dark-1280');

    // Dismissing needs a reason.
    await list.getByRole('button', { name: /review-kit@acme 1\.3\.0 is available \(user install\)/ }).click();
    await inspector.getByRole('button', { name: 'Dismiss…' }).click();
    const dismiss = inspector.getByRole('button', { name: 'Dismiss', exact: true });
    assert.equal(await dismiss.isDisabled(), true);
    await inspector.getByLabel('Why you do not want it').fill('Waiting for the team');
    await dismiss.click();
    await inspector.getByText('Dismissed by', { exact: false }).waitFor();
  } finally {
    await app.close();
  }
});

test('M13: an approved improvement becomes platform work with mandatory checks, a protected-change approval, and a tested backup', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const repo = platformRepo(join(home, 'code'));
  const { app, page } = await launch(join(home, 'app'));
  try {
    await resize(app, 1280, 900);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Platform', exact: true }).first().click();
    await page.getByRole('heading', { name: 'Set up platform maintenance' }).waitFor();
    await page.getByLabel('Source folder').fill(repo);
    await page.getByRole('button', { name: 'Set up' }).click();
    const kg = page.getByRole('list', { name: 'Known-good versions' });
    await kg.getByText('0.19.0', { exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Nothing approved yet' }).waitFor();

    // An approved item, from typed feedback.
    await page.evaluate(async () => {
      const i = await window.iap.addFeedback({ text: 'Adding two numbers gives the difference.', title: 'Sums are wrong' });
      if (!i.ok) throw new Error(i.error.message);
      await window.iap.editImprovement({ id: i.value.id, expectedOutcome: 'Sums are right', successCriteria: 'No wrong-sum reports for a week' });
      await window.iap.moveImprovement({ id: i.value.id, to: 'proposed' });
      const a = await window.iap.moveImprovement({ id: i.value.id, to: 'approved' });
      if (!a.ok) throw new Error(a.error.message);
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Improvements', exact: true }).first().click();
    await page.getByRole('list', { name: 'Improvements' }).getByRole('button', { name: /Sums are wrong/ }).click();
    const inspector = page.getByRole('region', { name: /IMP-1 Sums are wrong/ });
    await inspector.getByRole('button', { name: 'Build as platform work' }).click();
    await inspector.getByText(/is a draft in the platform-maintenance project/).waitFor();
    await inspector.getByText('In progress', { exact: true }).first().waitFor();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();

    await page.getByRole('button', { name: 'Platform', exact: true }).first().click();
    await page.getByRole('list', { name: 'Platform builds' }).getByText(/IMP-1: Sums are wrong/).waitFor();
    await page.getByRole('button', { name: 'Open the project' }).click();
    await page.getByText('This project is the app itself').waitFor();
    const panel = page.getByRole('region', { name: /Build work/ });
    const card = panel.locator('.build-card').first();
    await card.getByText(/Platform work for IMP-1/).waitFor();
    await card.getByText('deps: npm ci').waitFor();
    await card.getByRole('button', { name: 'Start and run checks' }).click();
    await card.getByText('In progress', { exact: true }).waitFor();

    // The fix plus a change to production configuration, made by hand in the worktree.
    const worktree = await card.locator('p:has-text("Branch") .mono').nth(1).innerText();
    writeFileSync(join(worktree, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b;\n');
    const pkg = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8'));
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ ...pkg, description: 'adds numbers' }, null, 2));
    await card.getByRole('button', { name: 'Verify', exact: true }).click();
    await card.getByText('Ready for review', { exact: true }).waitFor();
    await card.getByRole('list', { name: 'Risks' }).getByText(/production configuration: package\.json/).waitFor();
    await card.getByLabel(/Why the remaining risks are acceptable/).fill('The description change is wanted.');
    await card.getByRole('button', { name: 'Mark done' }).click();
    await card.getByText(/without your separate approval/).waitFor();
    await card.getByLabel('Why these protected changes are needed').fill('Adds a description for the installer.');
    await card.getByRole('button', { name: 'Approve protected changes…' }).click();
    await card.getByText('Protected changes approved').waitFor();
    await card.scrollIntoViewIfNeeded();
    await shot(page, '29-platform-build-dark-1280');
    await card.getByLabel(/Why the remaining risks are acceptable/).fill('Protected change approved; the unit check covers the fix.');
    await card.getByRole('button', { name: 'Mark done' }).click();
    await panel.getByText('Done', { exact: true }).waitFor();
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '', 'the source checkout is never edited');

    // A backup before installing the new version, and a recovery drill on a copy.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Platform', exact: true }).first().click();
    await page.getByRole('button', { name: 'Take a backup' }).click();
    const backups = page.getByRole('list', { name: 'Backups' });
    await backups.getByText('Restorable').waitFor();
    await backups.getByRole('button', { name: 'Test recovery' }).click();
    await page.getByText('Recovery test passed').waitFor();
    await page.locator('.content').evaluate((el) => el.scrollTo(0, 0));
    await shot(page, '30-platform-dark-1280');
  } finally {
    await app.close();
  }
});

test('M14: feedback about the work becomes an approved preference, a duplicate needs a decision, and a wrap-up is saved to the Vault', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const { app, page } = await launch(home);
  try {
    await resize(app, 1280, 900);
    await page.evaluate(async () => {
      const p = await window.iap.createProject({ name: 'Club HR', facts: [{ kind: 'assumption', text: 'About 40 members' }] });
      if (!p.ok) throw new Error(p.error.message);
      const r = await window.iap.startRun({ projectId: p.value.id, workflow: 'plan', title: 'Plan payroll' });
      if (!r.ok) throw new Error(r.error.message);
      await window.iap.moveRun({ runId: r.value.id, to: 'planned' });
      await window.iap.moveRun({ runId: r.value.id, to: 'blocked', reason: 'Waiting on the treasurer', resolution: 'Ask for the pay rates' });
    });

    // One feedback box: feedback about how the work is done becomes a proposed preference.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Improvements', exact: true }).first().click();
    await page.getByRole('radio', { name: 'How I want work done' }).check();
    await page.getByLabel('What would you like done differently?').fill('Please use British English in the interface text');
    await page.getByRole('button', { name: 'Propose preference' }).click();
    await page.getByText('Proposed as PREF-1').waitFor();
    await page.getByRole('button', { name: 'Open Preferences' }).click();

    const waiting = page.getByRole('list', { name: 'Proposed preferences' });
    await waiting.getByRole('button', { name: /Use British English in the interface text\./ }).click();
    const inspector = page.getByRole('region', { name: 'PREF-1' });
    await inspector.getByText('From feedback').waitFor();
    await inspector.getByText('“Please use British English in the interface text”').waitFor();
    await inspector.getByLabel('Wording').fill('Use British English in all interface text');
    await inspector.getByRole('button', { name: 'Save wording' }).click();
    await inspector.getByText('The app proposed: Use British English in the interface text.').waitFor();
    await inspector.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('list', { name: 'Active preferences' }).getByText('Use British English in all interface text.').waitFor();

    // A near duplicate is shown, and the person decides.
    await page.getByLabel('How would you like the work done?').fill('Use British English in interface text');
    await page.getByRole('button', { name: 'Propose', exact: true }).click();
    const second = page.getByRole('region', { name: 'PREF-2' });
    await second.getByText('1 active preference may overlap').waitFor();
    await second.getByText('May duplicate').waitFor();
    assert.equal(await second.getByRole('button', { name: 'Approve' }).isDisabled(), true, 'a duplicate needs a decision first');
    await second.getByRole('radio', { name: 'This one replaces PREF-1' }).check();
    await page.locator('.content').evaluate((el) => el.scrollTo(0, 0));
    await shot(page, '31-preferences-duplicate-dark-1280');
    await second.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('list', { name: 'Active preferences' }).getByText('Use British English in interface text.').waitFor();
    await page.getByText('History (1)').click();
    await page.getByRole('list', { name: 'Rejected and removed preferences' }).getByText('Use British English in all interface text.').waitFor();

    // The wrap-up comes from the records and is saved only when asked.
    await page.getByRole('button', { name: 'Wrap-up', exact: true }).first().click();
    const decisions = page.getByRole('region', { name: /Decisions/ });
    await decisions.getByText(/Approved the preference PREF-2 "Use British English in interface text\."/).waitFor();
    await page.getByRole('region', { name: /Blockers/ }).getByText(/"Plan payroll" in Club HR is blocked: Waiting on the treasurer/).waitFor();
    await page.getByRole('region', { name: /Assumptions/ }).getByText('Club HR: About 40 members').waitFor();
    await page.getByRole('button', { name: 'Save to the Vault inbox' }).click();
    await page.getByText(/NOTE-1 is in the Vault inbox\. It is a note, not a rule/).waitFor();
    await page.locator('.content').evaluate((el) => el.scrollTo(0, 0));
    await shot(page, '32-wrap-up-dark-1280');

    await page.getByRole('button', { name: 'Vault', exact: true }).first().click();
    await page.getByRole('list', { name: 'Vault notes' }).getByRole('button', { name: /NOTE-1/ }).click();
    const lines = page.getByRole('list', { name: 'Lines of the summary' });
    await lines.getByText(/"Plan payroll" in Club HR is blocked/).waitFor();
    await page.getByRole('button', { name: 'Keep', exact: true }).click();
    await page.getByRole('button', { name: 'Keep', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Kept', exact: true }).click();
    await page.getByRole('list', { name: 'Vault notes' }).getByRole('button', { name: /NOTE-1/ }).waitFor();
  } finally {
    await app.close();
  }
});

test('M14: lessons from a transcript are cited and kept apart from suggestions, repeated work becomes an exported skill, and add-ons are reviewed', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const incoming = join(home, 'Downloads');
  mkdirSync(incoming);
  writeFileSync(
    join(incoming, 'review-talk.vtt'),
    'WEBVTT\n\n00:00:01.000 --> 00:00:06.000\nSmall pull requests get reviewed faster, so keep each change to one idea.\n\n00:00:07.000 --> 00:00:12.000\nWrite the failing test before you fix a bug, then make it pass.\n',
  );
  writeFileSync(join(incoming, 'review-talk.mp4'), 'not a real video');
  const exports = join(home, 'exports');
  mkdirSync(exports);
  const { app, page } = await launch(home);
  try {
    await resize(app, 1280, 900);
    await page.evaluate(async () => {
      const p = await window.iap.createProject({ name: 'Club HR' });
      if (!p.ok) throw new Error(p.error.message);
      for (const title of ['Fix the CSV export of the members list', 'Fix the CSV export of the events list', 'Fix the CSV export for payments']) {
        const b = await window.iap.createBuild({ projectId: p.value.id, kind: 'bugfix', title, goal: title, repro: 'Export, then open the file', components: ['src/export.ts'], checks: [{ id: 'unit', command: 'npm test' }] });
        if (!b.ok) throw new Error(b.error.message);
      }
    });
    await page.reload();
    await page.waitForSelector('#main');
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('button', { name: 'Preferences and lessons' }).click();
    await page.getByRole('button', { name: 'Lessons', exact: true }).first().click();

    // Sources come from the native picker, stubbed here; the video is refused.
    await app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: paths })) as typeof dialog.showOpenDialog;
    }, [join(incoming, 'review-talk.vtt'), join(incoming, 'review-talk.mp4')]);
    await page.getByRole('button', { name: 'Add sources' }).click();
    await page.getByText(/review-talk\.mp4: Claude cannot watch videos here/).waitFor();
    const detail = page.getByRole('region', { name: 'SRC-1 review talk' });
    await detail.getByText('Not read yet.', { exact: false }).waitFor();
    await detail.getByRole('button', { name: 'Read for lessons' }).click();
    const lessons = detail.getByRole('list', { name: 'Lessons' });
    await lessons.getByText(/\[Simulated\] The source says: “Small pull requests get reviewed faster/).waitFor();
    await lessons.getByText('00:01–00:12').waitFor();
    await detail.getByText('simulated, no AI read it', { exact: false }).waitFor();
    const suggestions = detail.getByRole('list', { name: 'Suggestions' });
    await suggestions.getByText(/No AI read this source/).waitFor();
    assert.equal(await page.evaluate(async () => ((await window.iap.listPreferences()) as { ok: true; value: unknown[] }).value.length), 0, 'reading changed nothing else');
    await page.locator('.content').evaluate((el) => el.scrollTo(0, 0));
    await shot(page, '33-lessons-dark-1280');
    await suggestions.getByRole('button', { name: 'Set aside' }).click();
    await detail.getByText('Suggestion 1 set aside.').waitFor();
    await detail.getByRole('button', { name: 'Save to the Vault inbox' }).click();
    await detail.getByText('Saved to the Vault inbox. It is a note, not a rule.').waitFor();

    // Repeated work becomes a proposal; approval needs a tool scan first.
    await page.getByRole('button', { name: 'Skills', exact: true }).first().click();
    await page.getByRole('button', { name: 'Look for repeated work' }).click();
    await page.getByText(/Proposed SKL-1 from \d+ pieces of work/).waitFor();
    const skill = page.getByRole('region', { name: 'SKL-1 fix-csv-export-list' });
    await skill.getByRole('list', { name: 'Examples' }).getByText('Fix the CSV export of the events list').waitFor();
    await skill.getByLabel('SKILL.md preview').getByText(/## Permissions/).waitFor();
    await skill.getByRole('button', { name: 'Approve' }).click();
    await skill.getByText(/Scan your tools first/).first().waitFor();
    await page.evaluate(() => window.iap.scanTools());
    await skill.getByRole('button', { name: 'Approve' }).click();
    await skill.getByText('approved', { exact: true }).waitFor();
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, exports);
    await skill.getByRole('button', { name: 'Export SKILL.md…' }).click();
    await skill.getByText(/Wrote .*SKILL\.md\. Copy it into Claude Code yourself/).waitFor();
    assert.match(readFileSync(join(exports, 'fix-csv-export-list', 'SKILL.md'), 'utf8'), /^---\nname: fix-csv-export-list\n/);
    await page.locator('.content').evaluate((el) => el.scrollTo(0, 0));
    await shot(page, '34-skill-proposal-dark-1280');

    // Add-ons: twelve, each reviewed on its own; none is found, so none can be included.
    await page.getByRole('button', { name: 'Add-ons', exact: true }).first().click();
    await page.getByText('The app works without any of these').waitFor();
    assert.equal(await page.locator('.addon-grid > .card').count(), 12);
    const cache = page.getByRole('region', { name: 'cache-tax / keepwarm' });
    await cache.getByText('Review', { exact: true }).click();
    assert.equal(await cache.getByRole('radio', { name: 'Include' }).isDisabled(), true, 'an add-on the scan did not find cannot be included');
    await cache.getByRole('radio', { name: 'Exclude' }).check();
    await cache.getByLabel('Reason for cache-tax / keepwarm').fill('Keeping the cache warm makes model calls; not worth it at $20 a month.');
    await cache.getByRole('button', { name: 'Record the decision' }).click();
    await cache.getByText('exclude', { exact: true }).waitFor();
    await page.locator('.content').evaluate((el) => el.scrollTo(0, 0));
    await shot(page, '35-addons-dark-1280');
  } finally {
    await app.close();
  }
});

test('M15: say what to build, watch the steps, review and keep the change (simulated)', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const { app, page } = await launch(home);
  try {
    await resize(app, 1280, 800);
    // Four places in the rail, the rest one level down.
    const rail = page.getByRole('navigation', { name: 'Primary' });
    assert.deepEqual(await rail.getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))), ['Build', 'Projects', 'Library', 'Settings']);

    // With no project yet, the composer asks for a name and makes one.
    const composer = page.getByRole('form', { name: 'Start a task' });
    await composer.getByLabel('What do you want to build?').fill('Add a page that lists members');
    await composer.getByLabel('New project name').fill('Club HR');
    await composer.getByRole('button', { name: 'Start' }).click();

    const work = page.getByRole('article', { name: 'Add a page that lists members' });
    await work.getByRole('list', { name: 'What Claude is doing' }).getByText('Setting up a separate copy of your code').waitFor();
    // When it ends, the work becomes a report (M16): the simulated model changes nothing.
    const report = work.getByRole('region', { name: 'Report' });
    await report.getByRole('heading', { name: 'Nothing changed' }).waitFor({ timeout: 30_000 });
    // No checks were found, so nothing tested it; that is listed before it ships.
    await report.getByRole('list', { name: 'Before it ships' }).getByText(/nothing tested the change/).waitFor();
    await report.getByLabel('At a glance').getByText('None set up').waitFor();

    // Stand in for Claude's edit, so the report has files, lines and a coloured diff to show.
    const worktree = (await report.locator('.kv-list dd.mono').last().textContent())!.trim();
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'members.ts'), "// Lists the club's members.\nexport function members(rows: string[]): string[] {\n  const out = rows.filter((r) => r.trim().length > 0);\n  return out.sort();\n}\n");
    writeFileSync(join(worktree, 'README.md'), '# Club HR\n\nA members page.\n');
    writeFileSync(join(worktree, 'index.html'), '<!doctype html><title>Members</title><body style="font:24px sans-serif;padding:40px;background:#f5f7fb"><h1>Members</h1><ul><li>Ana · Coach</li><li>Ben · Treasurer</li></ul></body>');
    await work.getByRole('button', { name: '← All work' }).click();
    await page.getByRole('list', { name: 'Your work' }).getByRole('button', { name: /Add a page that lists members/ }).click();
    await report.getByRole('heading', { name: 'Ready for your review' }).waitFor();
    const tree = report.getByRole('list', { name: 'Changed files' });
    assert.deepEqual((await tree.getByRole('button').allTextContents()).map((t) => t.replace(/\s+/g, '')), ['AREADME.md+3', 'Aindex.html+1', 'Amembers.ts+5']);
    await tree.getByRole('button', { name: /members\.ts/ }).click();
    const code = report.getByLabel('Changes to src/members.ts');
    await code.locator('.hl-k', { hasText: 'export' }).first().waitFor();
    await code.locator('.hl-c').first().waitFor();
    await report.getByLabel('At a glance').locator('.diff-add', { hasText: '+9' }).waitFor();
    // The step list is folded away under the report.
    await report.getByText(/How Claude did it · \d+ steps?/).waitFor();
    assert.equal(await work.getByText('Ready for your review.').isVisible(), false);
    // Live preview (M16 H): a plain index.html is served by the app, so no command needs approving.
    const preview = report.getByRole('region', { name: 'Preview' });
    await preview.getByText(/Preview runs its index\.html/).waitFor();
    await preview.getByRole('button', { name: 'Start preview' }).click();
    await preview.getByText(/Running on 127\.0\.0\.1:\d+/).waitFor();
    await preview.getByRole('img', { name: 'The page as it looks now' }).waitFor({ timeout: 30_000 });
    assert.match((await preview.getByRole('img').getAttribute('src'))!, /^data:image\/png;base64,/);
    await shot(page, '40-build-preview-dark-1280');
    await page.locator('.content').evaluate((el) => el.scrollTo(0, 0));
    await shot(page, '36-build-review-dark-1280');
    // The report is the densest screen: its text must read on the sky too (M17 N).
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      for (const top of [0, 600, 1200]) {
        await page.locator('.content').evaluate((el, y) => el.scrollTo(0, y), top);
        const { failures } = await contrastFailures(app, page);
        assert.deepEqual(failures, [], `report text below WCAG AA contrast (${theme}, scrolled to ${top})`);
      }
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));

    // Keeping is one tap; the record still says what was open.
    await report.getByRole('button', { name: 'Keep', exact: true }).click();
    await report.getByRole('heading', { name: 'Kept' }).first().waitFor();
    await work.getByText(/nothing was merged or pushed for you/).waitFor();
    await report.getByText(/^Kept from the review with \d open points?: .*not run/).waitFor({ state: 'attached' });

    await work.getByRole('button', { name: '← All work' }).click();
    const list = page.getByRole('list', { name: 'Your work' });
    await list.getByRole('button', { name: /Add a page that lists members.*Club HR.*Kept/ }).waitFor();
    await shot(page, '37-build-home-dark-1280');

    // The project page leads with the same composer and its own tasks.
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Club HR' }).click();
    // Its tasks are an outcomes board (M17 K): the kept task's card shows the last picture of its page.
    const kept = page.getByRole('region', { name: 'Tasks' }).getByRole('list', { name: 'Kept' });
    await kept.getByRole('img', { name: 'The page from “Add a page that lists members”' }).waitFor();
    await shot(page, '38-project-tasks-dark-1280');

    // Settings holds the maintenance screens as tabs.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const tabs = page.getByRole('navigation', { name: 'Settings sections' });
    assert.deepEqual(await tabs.getByRole('button').allTextContents(), ['General', 'Activity', 'Tools', 'Updates', 'Improvements', 'Platform']);
    await shot(page, '39-settings-tabs-dark-1280');
  } finally {
    await app.close();
  }
});

test('M17-N: text is readable on both skies, the tour explains the rail once, and the keyboard reaches everything', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  let { app, page } = await launch(home);
  try {
    await resize(app, 1280, 800);
    // The first-run tour names what each rail item is for.
    const tour = page.getByRole('complementary', { name: 'Getting around' });
    await tour.waitFor();
    assert.match(await tour.innerText(), /Projects[\s\S]*Library[\s\S]*Settings[\s\S]*Ctrl K/);
    await shot(page, '50-tour-light-1280');

    for (const theme of ['Light', 'Dark'] as const) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('radio', { name: theme }).check();
      await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme.toLowerCase());
      for (const where of ['Build', 'Projects', 'Library', 'Settings']) {
        await page.getByRole('button', { name: where, exact: true }).click();
        await page.waitForTimeout(200);
        const { failures, checked } = await contrastFailures(app, page);
        assert.ok(checked > 5, `${where} (${theme}): too little text checked (${checked})`);
        assert.deepEqual(failures, [], `${where} (${theme}): text below WCAG AA contrast`);
      }
    }

    // Every control on the Build screen can be reached with Tab and shows where focus is.
    await page.getByRole('button', { name: 'Build', exact: true }).click();
    const reached: string[] = [];
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      // Focus is visible when the control, or the field around it, looks different focused than not.
      const f = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const ring = () => {
          const out: string[] = [];
          for (let a: HTMLElement | null = el, i = 0; a && i < 3; a = a.parentElement, i++) {
            const s = getComputedStyle(a);
            out.push(`${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}|${s.boxShadow}|${s.borderColor}`);
          }
          return out.join(';');
        };
        const focused = ring();
        el.blur();
        const blurred = ring();
        el.focus({ focusVisible: true } as FocusOptions);
        const label = (el as HTMLInputElement).labels?.[0]?.textContent?.trim();
        return { name: el.getAttribute('aria-label') || label || el.textContent?.trim() || el.tagName, visible: focused !== blurred };
      });
      assert.ok(f.visible, `no visible focus on "${f.name}"`);
      reached.push(f.name);
    }
    for (const name of ['Build', 'Settings', 'Got it', 'What do you want to build?']) assert.ok(reached.includes(name), `Tab never reached "${name}": ${reached.join(', ')}`);

    // Ctrl K opens the launcher from anywhere and Escape closes it.
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('combobox').or(page.getByRole('dialog').getByRole('textbox')).first().waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });

    // Got it hides the tour for good.
    await tour.getByRole('button', { name: 'Got it' }).click();
    await tour.waitFor({ state: 'detached' });
  } finally {
    await app.close();
  }
  ({ app, page } = await launch(home));
  try {
    await page.getByRole('button', { name: 'Build', exact: true }).waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole('complementary', { name: 'Getting around' }).count(), 0);
  } finally {
    await app.close();
  }
});

test('M17-M: the work shows named stages and plain steps, can be paused and continued, and the report says what went wrong', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const { app, page } = await launch(home);
  try {
    await resize(app, 1280, 800);
    await page.getByRole('complementary', { name: 'Getting around' }).getByRole('button', { name: 'Got it' }).click();
    const composer = page.getByRole('form', { name: 'Start a task' });
    await composer.getByLabel('What do you want to build?').fill('Add a page that lists members');
    await composer.getByLabel('New project name').fill('Club HR');
    await composer.getByRole('button', { name: 'Start' }).click();
    let work = page.getByRole('article', { name: 'Add a page that lists members' });
    let report = work.getByRole('region', { name: 'Report' });
    await report.getByRole('heading', { name: 'Nothing changed' }).waitFor({ timeout: 30_000 });
    // The steps read as plain words, not tool names.
    await report.getByText(/How Claude did it/).click();
    await report.getByRole('list', { name: /What Claude (is doing|did)/ }).getByText(/^Looked at the files in/).first().waitFor();

    // Give the project a slow test, so there is time to pause.
    const worktree = (await report.locator('.kv-list dd.mono').last().textContent())!.trim();
    const repo = join(execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: worktree, encoding: 'utf8' }).trim(), '..');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "setTimeout(() => {}, 4000)"' } }));
    execFileSync('git', ['add', 'package.json'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'slow test'], { cwd: repo });
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });

    await work.getByRole('button', { name: '← All work' }).click();
    await composer.getByLabel('What do you want to build?').fill('Add a holiday report');
    await composer.getByRole('button', { name: 'Start' }).click();
    work = page.getByRole('article', { name: 'Add a holiday report' });
    const stages = work.getByRole('list', { name: 'Stages' });
    await stages.locator('[aria-current="step"]').filter({ hasText: 'Getting ready' }).waitFor({ timeout: 15_000 });
    await work.getByRole('button', { name: 'Pause' }).click();
    await work.getByRole('status').filter({ hasText: /^Paused/ }).waitFor();
    await work.getByText('You paused the work. Claude waits before its next step.').waitFor();
    // The check finishes, then Claude waits at its first step.
    await stages.locator('[aria-current="step"]').filter({ hasText: 'Understanding the code' }).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1_500);
    assert.equal(await work.getByRole('button', { name: 'Continue' }).count(), 1, 'still paused');
    assert.equal(await work.getByText(/^Looked at the files in/).count(), 0, 'no step taken while paused');
    await shot(page, '51-build-paused-light-1280');
    await work.getByRole('button', { name: 'Continue' }).click();
    report = work.getByRole('region', { name: 'Report' });
    await report.getByRole('heading', { name: 'Nothing changed' }).waitFor({ timeout: 30_000 });

    // A failing check gets a plain explanation and a ready request for Claude.
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }));
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'failing test'], { cwd: repo });
    await work.getByRole('button', { name: '← All work' }).click();
    await composer.getByLabel('What do you want to build?').fill('Add a rota page');
    await composer.getByRole('button', { name: 'Start' }).click();
    work = page.getByRole('article', { name: 'Add a rota page' });
    report = work.getByRole('region', { name: 'Report' });
    await report.getByRole('heading', { name: /1 of 1 check is failing/ }).waitFor({ timeout: 30_000 });
    const trouble = report.getByRole('region', { name: 'What went wrong' });
    await trouble.getByText('The test check failed after the change.').waitFor();
    await trouble.getByRole('button', { name: 'Ask Claude to fix it' }).click();
    assert.match(await work.getByLabel('What to change').inputValue(), /^Fix the failing test check/);
    await shot(page, '52-build-trouble-light-1280');
  } finally {
    await app.close();
  }
});

test('M17-K: what is left before it ships is kept as to-dos on the project, ticked off or turned into a task', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const { app, page } = await launch(home);
  try {
    await resize(app, 1280, 800);
    await page.getByRole('complementary', { name: 'Getting around' }).getByRole('button', { name: 'Got it' }).click();
    const composer = page.getByRole('form', { name: 'Start a task' });
    await composer.getByLabel('What do you want to build?').fill('Add a page that lists members');
    await composer.getByLabel('New project name').fill('Club HR');
    await composer.getByRole('button', { name: 'Start' }).click();
    const work = page.getByRole('article', { name: 'Add a page that lists members' });
    const report = work.getByRole('region', { name: 'Report' });
    await report.getByRole('heading', { name: 'Nothing changed' }).waitFor({ timeout: 30_000 });
    // The list in the report can be ticked off.
    const ships = report.getByRole('list', { name: 'Before it ships' });
    const tested = ships.getByRole('checkbox', { name: /nothing tested the change/ });
    await tested.click(); // saved, then shown ticked
    await ships.locator('li[data-status="done"]').filter({ hasText: /nothing tested the change/ }).waitFor();
    await tested.click();
    await ships.locator('li[data-status="open"]').filter({ hasText: /nothing tested the change/ }).waitFor();
    await report.getByRole('button', { name: 'Keep', exact: true }).click();
    await report.getByRole('heading', { name: 'Kept' }).first().waitFor();

    // Kept, the open points wait on the project page.
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Club HR' }).click();
    const left = page.getByRole('region', { name: /Left to do/ });
    await left.getByText(/From “Add a page that lists members”/).first().waitFor();
    assert.equal(await left.getByRole('checkbox').count(), 2);
    await shot(page, '53-project-todos-light-1280');
    await left.getByRole('checkbox', { name: /^Nothing changed in the worktree/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Left to do"] input[type=checkbox]').length === 1);
    // The other becomes a new task of its own.
    await left.getByRole('button', { name: /^Start a task for: No check commands were found/ }).click();
    const fromTodo = page.getByRole('article', { name: /^No check commands were found/ });
    await fromTodo.getByRole('region', { name: 'Report' }).waitFor({ timeout: 30_000 });
    await fromTodo.getByRole('button', { name: '← All work' }).click();

    // On the board, selecting a card shows the actions for that task only.
    const waiting = page.getByRole('list', { name: 'Waiting for you' });
    const card = waiting.getByRole('button', { name: /^No check commands were found/ });
    assert.equal(await page.getByRole('toolbar').count(), 0, 'no actions until a card is selected');
    await card.click();
    const tools = page.getByRole('toolbar', { name: /^Actions for No check commands were found/ });
    assert.deepEqual(await tools.getByRole('button').allTextContents(), ['Open report', 'Ask Claude', 'Preview', 'Undo', 'Keep']);
    await shot(page, '54-board-selected-light-1280');
    // Ask Claude opens the report ready to type.
    await tools.getByRole('button', { name: 'Ask Claude' }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'What to change');
    await fromTodo.getByRole('button', { name: '← All work' }).click();
    await card.click();
    await page.keyboard.press('Escape');
    await tools.waitFor({ state: 'detached' });
    await card.click();
    await tools.getByRole('button', { name: 'Undo' }).click();
    await page.getByRole('group').or(page.locator('details.outcome-group')).filter({ hasText: 'Undone' }).first().waitFor();
    assert.equal(await page.getByRole('list', { name: 'Waiting for you' }).count(), 0);
  } finally {
    await app.close();
  }
});
