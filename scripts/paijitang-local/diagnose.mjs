// Read-only environment diagnostics. No credential submission, CAPTCHA interaction,
// header/cookie recording, response-body recording, or browser fingerprint changes.
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runtime, atomicJson, log } from './collector.mjs';
const { chromium } = await import('playwright');

const endpoint = raw => { const u = new URL(raw); return `${u.origin}${u.pathname}`; };
const results = [];
for (const browser of ['chromium', 'msedge']) {
  const profile = await mkdtemp(path.join(runtime, `diagnostic-${browser}-`));
  let context, page;
  let phase = 'launch';
  const resources = [], failures = [], errors = [];
  const started = Date.now();
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...(browser === 'msedge' ? { channel: 'msedge' } : {}),
      headless: false, chromiumSandbox: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
      viewport: { width: 1440, height: 1000 },
    });
    page = context.pages()[0] || await context.newPage();
    page.on('response', r => resources.push({ endpoint: endpoint(r.url()), status: r.status(), type: r.request().resourceType() }));
    page.on('requestfailed', r => failures.push({ endpoint: endpoint(r.url()), error: r.failure()?.errorText, type: r.resourceType() }));
    page.on('pageerror', e => errors.push(e.name));
    phase = 'navigation';
    await page.goto('https://www.paijitang.com/universal/login?redirectUrl=https://www.paijitang.com/backend/wallet/bill', { waitUntil: 'domcontentloaded', timeout: 45000 });
    phase = 'login-form';
    await page.getByPlaceholder('请输入用户名').waitFor({ timeout: 20000 });
    // Give asynchronous public verification resources time to load; do not touch the form.
    await sleep(4000);
    const environment = await page.evaluate(() => ({
      userAgent: navigator.userAgent, webdriver: navigator.webdriver,
      language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      secureContext: window.isSecureContext, online: navigator.onLine,
    }));
    results.push({ browser, finalPage: endpoint(page.url()), formReady: true, environment,
      elapsedMs: Date.now() - started, resources, failures, pageErrorNames: errors });
    log('ENVIRONMENT_CHECKED', { browser, requests: resources.length, failed: failures.length, httpErrors: resources.filter(r => r.status >= 400), environment });
  } catch (e) {
    const visible = page ? await page.locator('body').innerText({ timeout: 2000 }).catch(() => '') : '';
    const pageState = { challenge: /访问验证|验证失败/.test(visible), loginText: /密码登录/.test(visible), finalPage: page ? endpoint(page.url()) : null };
    results.push({ browser, formReady: false, errorType: e.name, phase, pageState, elapsedMs: Date.now() - started, resources, failures, pageErrorNames: errors });
    log('ENVIRONMENT_CHECK_FAILED', { browser, errorType: e.name, phase, pageState });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
  await sleep(2000);
}
await atomicJson(path.join(runtime, 'environment-diagnostic.json'), { testedAt: new Date().toISOString(), results });
