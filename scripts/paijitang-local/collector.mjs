import { mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BILL_URL, validateRange, matchesBill, validatePage, digest } from './core.mjs';
import { attachDiagnostics } from './network-diagnostics.mjs';

process.umask(0o077);
export const runtime = path.join(path.dirname(fileURLToPath(import.meta.url)), '.runtime');
export const profilePath = path.join(runtime, 'manual-edge-profile');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(runtime, 'browsers');
const { chromium } = await import('playwright');
export const log = (event, details = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));

export async function atomicJson(name, value) {
  await mkdir(path.dirname(name), { recursive: true, mode: 0o700 });
  const temp = `${name}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, name);
}
export async function lock() {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const name = path.join(runtime, 'collector.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(name, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => unlink(name).catch(() => {});
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(await readFile(name, 'utf8').catch(() => '0'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('采集锁异常，请检查正在运行的进程');
      try { process.kill(pid, 0); } catch (error) {
        if (error.code === 'ESRCH') { await unlink(name); continue; }
        throw error;
      }
      throw new Error('采集浏览器已被其他任务占用');
    }
  }
  throw new Error('无法取得采集锁');
}
async function launch(headless = false) {
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: 'msedge', headless, chromiumSandbox: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    // Keep the same OS credential store as the ordinary Edge login process.
    // Playwright's mock keychain cannot read cookies encrypted by native Edge.
    ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'],
    viewport: { width: 1440, height: 1000 }, acceptDownloads: false,
  });
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(45000);
  const page = context.pages()[0] || await context.newPage();
  return { context, page };
}
export async function login({ diagnostic = false } = {}) {
  const release = await lock();
  let context, stopDiagnostics;
  try {
    const browser = await launch(false); context = browser.context;
    const page = browser.page;
    if (diagnostic) stopDiagnostics = attachDiagnostics(page, report => atomicJson(path.join(runtime, 'login-network-diagnostic.json'), report));
    await page.goto(BILL_URL, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    log('LOGIN_WINDOW_READY', { message: '诊断模式：请在专用 Edge 窗口登录并完成验证。会话保存在本机；不读取或保存密码。' });
    const deadline = Date.now() + 20 * 60 * 1000;
    // Login may redirect to home first; only return to bills after the login form disappears.
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error('登录窗口已关闭');
      if (!/\/login(?:\?|$)/.test(new URL(page.url()).pathname) &&
          await page.getByText(/你好，/).isVisible().catch(() => false)) break;
      if (new URL(page.url()).pathname === '/' &&
          await page.getByText(/个人中心/).first().isVisible().catch(() => false)) break;
      await sleep(1000);
    }
    if (Date.now() >= deadline) throw new Error('登录等待超时，请重新运行 login');
    await page.goto(BILL_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /查\s*询/ }).waitFor();
    // Verify a real bill response, not just the existence of a cookie or page shell.
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/opt-decision/bill/recycler/v2' && r.request().method() === 'POST', { timeout: 60000 });
    await page.getByRole('button', { name: /查\s*询/ }).click();
    const r = await response;
    const body = await r.json().catch(() => null);
    if (r.status() !== 200 || body?.code !== 200) throw new Error('AUTH_REQUIRED: 登录后账单查询未通过，请在窗口完成验证后重试');
    await atomicJson(path.join(runtime, 'login-status.json'), { verifiedAt: new Date().toISOString(), valid: true });
    log('LOGIN_VERIFIED', { message: '账单查询成功，将关闭窗口。之后可测试浏览器重新启动后的无人值守采集。' });
  } finally { await stopDiagnostics?.(); await context?.close(); await release(); }
}

async function setRange(page, start, end) {
  await page.getByRole('textbox', { name: '开始日期', exact: true }).click();
  // Ant Design's popup inputs are editable; the main range display is read-only.
  const startInput = page.getByRole('textbox', { name: '开始日期', exact: true }).last();
  const endInput = page.getByRole('textbox', { name: '结束日期', exact: true }).last();
  await startInput.fill(start);
  await endInput.fill(end);
  await endInput.press('Enter');
  await page.getByRole('button', { name: /查\s*询/ }).click({ trial: true });
}
async function fetchPage(page, start, end, index, expectedTotal) {
  const waiter = page.waitForResponse(r => matchesBill(r.request(), start, end, index), { timeout: 45000 });
  // Observe the request generated by the normal UI; never construct signatures or bypass challenges.
  const action = index === 0
    ? page.getByRole('button', { name: /查\s*询/ }).click()
    : page.locator('li[title="下一页"]').click();
  const [response] = await Promise.all([waiter, action]);
  if (response.status() !== 200) throw new Error(`账单 HTTP 状态 ${response.status()}`);
  const body = await response.json().catch(() => { throw new Error('AUTH_REQUIRED: 返回了访问校验页，需要人工处理'); });
  const rows = validatePage(body, index, start, end, expectedTotal);
  if (body.totalCount) {
    await page.getByText(`共 ${body.totalCount} 条记录 第 ${index + 1} / ${Math.ceil(body.totalCount / 20)} 页`, { exact: true }).waitFor();
  } else {
    await page.getByText('暂无数据', { exact: true }).waitFor();
  }
  return { rows, total: body.totalCount };
}
async function attempt(start, end, headless) {
  const { context, page } = await launch(headless);
  try {
    await page.goto(BILL_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /查\s*询/ }).waitFor({ timeout: 20000 }).catch(async () => {
      await atomicJson(path.join(runtime, 'session-reuse-diagnostic.json'), {
        at: new Date().toISOString(), pathname: new URL(page.url()).pathname,
        loginVisible: await page.getByText('密码登录', { exact: true }).isVisible().catch(() => false),
        challengeVisible: await page.getByText('访问验证', { exact: true }).isVisible().catch(() => false),
      });
      throw new Error('AUTH_REQUIRED: 未进入账单页，请运行 login 完成登录');
    });
    await setRange(page, start, end);
    const first = await fetchPage(page, start, end, 0);
    if (first.total > 100000) throw new Error('数据量超过本地验证上限，请拆分日期范围');
    const rows = [...first.rows];
    const pageDigests = new Set(first.rows.length ? [digest(first.rows)] : []);
    for (let index = 1; index < Math.ceil(first.total / 20); index++) {
      await sleep(2000);
      const next = await fetchPage(page, start, end, index, first.total);
      const fingerprint = digest(next.rows);
      if (pageDigests.has(fingerprint)) throw new Error('分页内容重复，拒绝发布可能不完整的数据');
      pageDigests.add(fingerprint); rows.push(...next.rows);
      log('PAGE_COLLECTED', { start, end, page: index + 1, count: rows.length, total: first.total });
    }
    if (rows.length !== first.total) throw new Error('采集未覆盖全部记录');
    return { source: BILL_URL, start, end, total: first.total, digest: digest(rows), collectedAt: new Date().toISOString(), rows };
  } finally { await context.close(); }
}
export async function collect(start, end, { headless = false, publish = true } = {}) {
  validateRange(start, end);
  const release = await lock();
  try {
    let data;
    for (let n = 0; n < 2; n++) {
      try { data = await attempt(start, end, headless); break; }
      catch (e) {
        if (e.message.startsWith('AUTH_REQUIRED') || n === 1) throw e;
        log('RETRY', { message: '本轮失败，等待 10 秒后从第一页完整重试' });
        await sleep(10000);
      }
    }
    if (publish) await atomicJson(path.join(runtime, 'data', `${start}_${end}.json`), data);
    log('COLLECTED', { start, end, total: data.total, digest: data.digest, headless });
    return data;
  } catch (e) {
    if (e.message.startsWith('AUTH_REQUIRED')) {
      await atomicJson(path.join(runtime, 'login-status.json'), { valid: false, status: 'needs_manual_login', checkedAt: new Date().toISOString() });
    }
    await atomicJson(path.join(runtime, 'last-error.json'), { time: new Date().toISOString(), start, end, needsLogin: e.message.startsWith('AUTH_REQUIRED'), message: e.message.startsWith('AUTH_REQUIRED') ? e.message : '采集失败；完整数据未发布，请查看终端诊断' });
    throw e;
  } finally { await release(); }
}
