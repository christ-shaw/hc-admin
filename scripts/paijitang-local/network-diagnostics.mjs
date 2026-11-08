// Never retain request bodies/headers, response bodies, cookies, or URL queries.
export function safeCodes(text) {
  let value;
  try { value = JSON.parse(text); } catch {
    const jsonp = text.match(/^\s*[\w.$]+\s*\((\{[\s\S]*\})\)\s*;?\s*$/);
    if (!jsonp) return {};
    try { value = JSON.parse(jsonp[1]); } catch { return {}; }
  }
  const result = {};
  const walk = (obj, prefix = '', depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 2) return;
    for (const [key, v] of Object.entries(obj)) {
      const name = prefix + key;
      if (/^(code|errorCode|error_code|resultCode|verifyCode|verifyResult|status|success|passed|error)$/i.test(key) &&
          (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ||
           (typeof v === 'string' && /^(?:[A-Z][A-Z0-9_:-]{0,24}|[0-9]{1,9}|Success|success|fail|false|true|ok)$/.test(v)))) result[name] = v;
      if (['data', 'result'].includes(key.toLowerCase())) walk(v, name + '.', depth + 1);
    }
  };
  walk(value);
  return result;
}

export function attachDiagnostics(page, writeReport) {
  const report = { startedAt: new Date().toISOString(), requests: [], pageErrorCount: 0 };
  let writes = Promise.resolve();
  const pending = new Set();
  const save = () => { writes = writes.then(() => writeReport(report)).catch(() => {}); };
  const safeEndpoint = raw => {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !/(^|\.)(paijitang\.com|aihuishou\.com|alicdn\.com|aliyun\.com|aliyuncs\.com|aliapp\.org)$/.test(u.hostname)) return null;
    return u.origin + u.pathname;
  };
  const onResponse = response => {
    const endpoint = safeEndpoint(response.url());
    if (!endpoint || report.requests.length >= 500) return;
    const entry = { time: new Date().toISOString(), endpoint, status: response.status(), type: response.request().resourceType() };
    report.requests.push(entry);
    const inspect = (async () => {
      if (['xhr', 'fetch'].includes(entry.type) && /json|javascript/.test(response.headers()['content-type'] || '')) {
        const text = await response.text().catch(() => '');
        if (text.length < 100000) entry.codes = safeCodes(text);
      }
      save();
    })();
    pending.add(inspect); inspect.finally(() => pending.delete(inspect));
  };
  const onFailure = request => {
    const endpoint = safeEndpoint(request.url());
    if (endpoint && report.requests.length < 500) report.requests.push({ time: new Date().toISOString(), endpoint, networkError: request.failure()?.errorText, type: request.resourceType() });
    save();
  };
  const onError = () => { report.pageErrorCount++; save(); };
  page.on('response', onResponse); page.on('requestfailed', onFailure); page.on('pageerror', onError);
  save();
  return async () => {
    page.off('response', onResponse); page.off('requestfailed', onFailure); page.off('pageerror', onError);
    await Promise.allSettled([...pending]);
    await writes;
  };
}
