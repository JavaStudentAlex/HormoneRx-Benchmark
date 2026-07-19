import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'screenshots';
mkdirSync(OUT, { recursive: true });

const consoleErrors = [];
const failures = [];

function check(name, cond) {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}`); failures.push(name); }
}

const browser = await chromium.launch();

// ---- Desktop pass ----
const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await desktop.newPage();
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

async function goto(hash) {
  await page.goto(`${BASE}/#${hash}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
}

// Overview
await goto('/');
check('Overview shows project statement', await page.getByText('open evidence dataset and benchmark').first().isVisible());
check('Overview shows disclaimer footer', (await page.getByText('Research prototype. Not medical advice.').count()) > 0);
await page.screenshot({ path: `${OUT}/desktop-01-overview.png`, fullPage: true });

// Analyze Case — run positive demo case
await goto('/analyze');
await page.getByRole('button', { name: 'Positive evidence match' }).click();
await page.waitForTimeout(400);
check('Positive case -> Evidence found badge', (await page.getByText('Evidence found').count()) > 0);
check('Positive case -> INT-001 record shown', (await page.getByText('INT-001').count()) > 0);
check('Positive case shows source URL', (await page.getByText('fsrh.org').count()) > 0);
await page.screenshot({ path: `${OUT}/desktop-02-analyze-positive.png`, fullPage: true });

// Negated case
await page.getByRole('button', { name: 'Explicit negation' }).click();
await page.waitForTimeout(400);
check('Negated case -> Excluded context', (await page.getByText('Excluded context').count()) > 0);
check('Negated case -> no Evidence found', (await page.getByText('Evidence found').count()) === 0);
await page.screenshot({ path: `${OUT}/desktop-03-analyze-negated.png`, fullPage: true });

// Ambiguous case
await page.getByRole('button', { name: 'Incomplete hormonal context' }).click();
await page.waitForTimeout(400);
check('Ambiguous case -> More information required', (await page.getByText('More information required').count()) > 0);
await page.screenshot({ path: `${OUT}/desktop-04-analyze-ambiguous.png`, fullPage: true });

// Evidence Library — drawer + search
await goto('/evidence');
check('Evidence table shows all 6 records', (await page.getByText('INT-006').count()) > 0);
await page.getByRole('button', { name: 'Details' }).first().click();
await page.waitForTimeout(300);
check('Evidence drawer opens', (await page.getByRole('dialog').count()) > 0);
await page.screenshot({ path: `${OUT}/desktop-05-evidence-drawer.png`, fullPage: true });
await page.getByRole('button', { name: 'Close details' }).click();
await page.waitForTimeout(200);

// Benchmark — filters
await goto('/benchmark');
check('Benchmark shows trigger precision stat', (await page.getByText('Trigger precision').count()) > 0);
check('Benchmark case table present (CASE-001)', (await page.getByText('CASE-001').count()) > 0);
await page.selectOption('select >> nth=0', 'explicit_negation');
await page.waitForTimeout(300);
check('Filter to explicit_negation keeps CASE-012', (await page.getByText('CASE-012').count()) > 0);
check('Filter removes CASE-001', (await page.getByText('CASE-001').count()) === 0);
await page.screenshot({ path: `${OUT}/desktop-06-benchmark.png`, fullPage: true });

// About
await goto('/about');
check('About shows safety boundary', (await page.getByText('Safety boundary').count()) > 0);
await page.screenshot({ path: `${OUT}/desktop-07-about.png`, fullPage: true });

// ---- Mobile pass ----
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const mp = await mobile.newPage();
mp.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('mobile: ' + m.text()); });
await mp.goto(`${BASE}/#/`, { waitUntil: 'networkidle' });
await mp.waitForTimeout(300);
await mp.screenshot({ path: `${OUT}/mobile-01-overview.png`, fullPage: true });
await mp.goto(`${BASE}/#/analyze`, { waitUntil: 'networkidle' });
await mp.getByRole('button', { name: 'Positive evidence match' }).click();
await mp.waitForTimeout(400);
await mp.screenshot({ path: `${OUT}/mobile-02-analyze.png`, fullPage: true });
await mp.goto(`${BASE}/#/benchmark`, { waitUntil: 'networkidle' });
await mp.waitForTimeout(300);
await mp.screenshot({ path: `${OUT}/mobile-03-benchmark.png`, fullPage: true });

await browser.close();

console.log('\nConsole errors captured:', consoleErrors.length);
for (const e of consoleErrors) console.log('  ERR  ' + e);
check('No console errors', consoleErrors.length === 0);

console.log(`\nE2E summary: ${failures.length === 0 ? 'ALL CHECKS PASSED' : failures.length + ' CHECK(S) FAILED'}`);
process.exit(failures.length === 0 ? 0 : 1);
