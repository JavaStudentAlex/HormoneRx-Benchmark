import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const results = JSON.parse(readFileSync('src/data/benchmark_results.json', 'utf-8'));
const expectedAbstention = Math.round(results.metrics.correctAbstentionRate * 100) + '%';
const expectedPass = Math.round(results.metrics.passRate * 100) + '%';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(`${BASE}/#/benchmark`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const body = await page.locator('body').innerText();
await browser.close();

const abstentionOk = body.includes('Correct abstention') && body.includes(expectedAbstention);
const passOnOverview = await (async () => {
  const b2 = await chromium.launch();
  const p2 = await b2.newPage();
  await p2.goto(`${BASE}/#/`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(300);
  const t = await p2.locator('body').innerText();
  await b2.close();
  return t.includes(expectedPass);
})();

console.log(`benchmark_results.json correctAbstentionRate = ${expectedAbstention}, passRate = ${expectedPass}`);
console.log(`UI Benchmark page shows abstention ${expectedAbstention}: ${abstentionOk ? 'MATCH' : 'MISMATCH'}`);
console.log(`UI Overview page shows pass rate ${expectedPass}: ${passOnOverview ? 'MATCH' : 'MISMATCH'}`);
process.exit(abstentionOk && passOnOverview ? 0 : 1);
