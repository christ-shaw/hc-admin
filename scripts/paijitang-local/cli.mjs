import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { login, collect, atomicJson, runtime, log } from './collector.mjs';
import { dueDate, shiftDate, shanghaiClock, validateDate } from './core.mjs';
import { manualLogin } from './manual-login.mjs';

const [command, ...args] = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const headless = args.includes('--headless');
const end = value('--end') || shiftDate(shanghaiClock().date, -1);
const start = value('--start') || end;

try {
  if (command === 'login') {
    await manualLogin();
    await collect(end, end, { headless, publish: false });
    await atomicJson(path.join(runtime, 'login-status.json'), { verifiedAt: new Date().toISOString(), valid: true });
    log('LOGIN_VERIFIED', { message: '保存的登录状态已通过重启后的账单查询验证。' });
  }
  else if (command === 'diagnostic-login') await login({ diagnostic: true });
  else if (command === 'collect') await collect(start, end, { headless });
  else if (command === 'verify' || command === 'setup') {
    if (command === 'setup') await manualLogin();
    const first = await collect(start, end, { headless, publish: false });
    await atomicJson(path.join(runtime, 'login-status.json'), { verifiedAt: new Date().toISOString(), valid: true });
    await sleep(5000);
    const second = await collect(start, end, { headless, publish: false });
    const passed = first.total === second.total && first.digest === second.digest;
    const report = { testedAt: new Date().toISOString(), start, end, passed, headless, browserRestarts: 2, firstCount: first.total, secondCount: second.total, firstDigest: first.digest, secondDigest: second.digest };
    await atomicJson(path.join(runtime, 'verification.json'), report);
    if (!passed) throw new Error('两轮数据不一致，未通过无人值守验证');
    await atomicJson(path.join(runtime, 'data', `${start}_${end}.json`), second);
    await atomicJson(path.join(runtime, 'setup-status.json'), { updatedAt: report.testedAt, status: 'verified', unattendedPassed: true, start, end, headless });
    log('UNATTENDED_VERIFIED', report);
  } else if (command === 'serve') {
    // A foreground worker. No hidden launch agent or system settings are installed.
    const statePath = path.join(runtime, 'schedule.json');
    let state = await readFile(statePath, 'utf8').then(JSON.parse).catch(e => {
      if (e.code === 'ENOENT') return {};
      throw e;
    });
    let retryAt = 0;
    log('SERVICE_STARTED', { timezone: 'Asia/Shanghai', hour: '02:00', headless });
    while (true) {
      const due = dueDate();
      const next = state.lastSuccessDate ? shiftDate(validateDate(state.lastSuccessDate), 1) : (value('--start') || due);
      validateDate(next);
      if (next <= due && Date.now() >= retryAt) {
        try {
          await collect(next, next, { headless });
          state = { lastSuccessDate: next, completedAt: new Date().toISOString() };
          await atomicJson(statePath, state);
          retryAt = 0;
        } catch (e) {
          log('SERVICE_NEEDS_ATTENTION', { reason: e.message.startsWith('AUTH_REQUIRED') ? e.message : '采集失败，30 分钟后再试' });
          if (e.message.startsWith('AUTH_REQUIRED')) { process.exitCode = 2; break; }
          retryAt = Date.now() + 30 * 60 * 1000;
        }
      }
      await sleep(30000);
    }
  } else {
    console.log('用法: node cli.mjs login|setup|collect|verify|serve|diagnostic-login [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--headless]');
    process.exitCode = 1;
  }
} catch (e) {
  // Playwright error details can include selectors; never print headers, cookies, or request URLs.
  console.error(e.message.replace(/https?:\/\/\S+/g, '[URL omitted]'));
  process.exitCode = 1;
}
