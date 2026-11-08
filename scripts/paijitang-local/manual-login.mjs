import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BILL_URL } from './core.mjs';
import { runtime, lock, log, atomicJson, profilePath } from './collector.mjs';

// A normal browser process for human sign-in. No Playwright connection,
// remote debugging, fingerprint overrides, or CAPTCHA automation is used here.
export async function manualLogin() {
  if (process.platform !== 'darwin') throw new Error('当前人工登录入口适用于 macOS Edge');
  const executable = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  await access(executable);
  const release = await lock();
  try {
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    await atomicJson(path.join(runtime, 'login-status.json'), {
      valid: false, status: 'awaiting_manual_login', startedAt: new Date().toISOString(),
    });
    const child = spawn(executable, [
      `--user-data-dir=${profilePath}`, '--no-first-run', '--new-window', BILL_URL,
    ], { stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      let interrupted = false;
      let confirmedClose = false;
      const stop = () => { interrupted = true; child.kill('SIGTERM'); };
      // macOS can keep the app alive after its last window closes. Enter is an
      // explicit handoff; only this child process is asked to exit gracefully.
      const finish = chunk => {
        if (!/[\r\n]/.test(String(chunk))) return;
        confirmedClose = true;
        child.kill('SIGTERM');
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      process.stdin.on('data', finish);
      process.stdin.resume();
      const cleanup = () => {
        process.off('SIGINT', stop); process.off('SIGTERM', stop);
        process.stdin.off('data', finish); process.stdin.pause();
      };
      child.once('spawn', () => log('MANUAL_LOGIN_WINDOW_READY', {
        message: '请在专用 Edge 窗口手工登录并进入买入账单页。完成后关闭该专用窗口；若进程仍驻留，请在终端按 Enter，服务再验证保存的登录状态。',
        browser: 'Microsoft Edge', profile: 'manual-edge-profile',
      }));
      child.once('error', () => { cleanup(); reject(new Error('无法启动专用 Edge 登录窗口')); });
      child.once('exit', (code, signal) => {
        cleanup();
        if (interrupted || (!confirmedClose && (signal || code !== 0))) reject(new Error('人工登录流程中断；尚未验证登录状态'));
        else resolve();
      });
    });
    log('MANUAL_BROWSER_CLOSED', { message: '登录窗口已关闭，接下来通过真实账单查询验证会话。' });
  } finally { await release(); }
}
