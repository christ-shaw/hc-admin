'use strict';

// Each deployed function gets a copy via scripts/sync-sf-profile.cjs.
// Request-local routing: never mutate process.env when administrators switch.
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const LABELS = { hongcheng: '鸿城', huichuan: '汇川' };
function profile(value) {
  const p = String(value || 'hongcheng').trim();
  if (!Object.hasOwn(LABELS, p)) throw new Error('顺丰配置仅支持鸿城或汇川');
  return p;
}
function environment(value) {
  const e = String(value || 'sandbox').trim();
  if (e === 'production' || e === 'prod') return 'production';
  if (e === 'sandbox' || e === 'sbox') return 'sandbox';
  throw new Error('顺丰环境仅支持 sandbox 或 production');
}
function route() { return context.getStore(); }
function currentProfile() { return profile(route()?.sfConfigProfile); }
function tokenId(env) {
  // During rollout legacy callers and Hongcheng callers share the same cache.
  const e = environment(env);
  return currentProfile() === 'hongcheng' ? e : `huichuan:${e}`;
}
function envValue(name) {
  const p = currentProfile();
  const aliases = name.startsWith('SF_PROD_') ? [name, name.replace('SF_PROD_', 'SF_PRODUCTION_')]
    : name.startsWith('SF_PRODUCTION_') ? [name, name.replace('SF_PRODUCTION_', 'SF_PROD_')] : [name];
  const scoped = aliases.map(key => key.replace(/^SF_/, `SF_${p.toUpperCase()}_`));
  // Keep the identity used by old callers authoritative while sharing a cache.
  const keys = p === 'hongcheng' ? [...aliases, ...scoped] : scoped;
  return keys.map(key => process.env[key]).find(value => String(value || '').trim()) || '';
}
function pluginFlags(config, p) {
  const key = profile(p);
  return config?.pluginPrintEnabledByProfile?.[key]
    || (key === 'hongcheng' ? config?.pluginPrintEnabledByEnv : null)
    || { sandbox: false, production: false };
}
function storedRoute(record) {
  if (!record || !record.env) throw new Error('顺丰记录缺少原始环境，不能选择其他配置代替');
  return { sfConfigProfile: profile(record.sfConfigProfile), env: environment(record.env) };
}
async function getDoc(db, collection, id) {
  try { return (await db.collection(collection).doc(id).get()).data || null; }
  catch (e) {
    if (e.errCode === -1 || /not exist|not found/i.test(e.message || '')) return null;
    throw e;
  }
}
async function selectRoute(db, mode, payload) {
  // Existing shipment operations use the persisted route even after a switch.
  if (mode === 'record' && payload.sfExpressOrderId) {
    return storedRoute(await getDoc(db, 'sf_express_orders', String(payload.sfExpressOrderId)));
  }
  if (mode === 'record' && payload.action === 'record' && payload.requestID) {
    return storedRoute(await getDoc(db, 'sf_print_logs', String(payload.requestID)));
  }
  // Old callers cannot name an account: they must always receive Hongcheng.
  // Honor their captured sfEnv even if the administrator changed the global env.
  if (mode === 'token') {
    const p = profile(payload.sfConfigProfile);
    if (payload.sfConfigProfile && !payload.sfEnv) {
      throw new Error('指定顺丰配置时必须同时传入 sfEnv');
    }
    if (payload.sfEnv) return { sfConfigProfile: p, env: environment(payload.sfEnv) };
    const config = await getDoc(db, 'system_config', 'sf_express');
    return { sfConfigProfile: 'hongcheng', env: environment(config?.env || process.env.SF_ENV) };
  }
  const config = await getDoc(db, 'system_config', 'sf_express');
  const selected = {
    sfConfigProfile: profile(config?.activeProfile),
    env: environment(config?.env || process.env.SF_ENV),
  };
  if (mode === 'apply') {
    const id = String(payload.sourceOrderId || payload.orderId || '').trim();
    if (id) {
      const found = await db.collection('sf_express_orders')
        .where({ sourceOrderId: id, isCurrent: true }).limit(100).get();
      const live = (found.data || []).filter(r => r.status !== 'cancelled');
      if (live.length > 1) throw new Error('订单存在多条当前顺丰记录，请先核对，暂不重复下单');
      if (live.length) return storedRoute(live[0]);
    }
  }
  return selected;
}
function wrap(db, mode, handler) {
  return async (event = {}, ...args) => {
    try {
      const selected = await selectRoute(db, mode, event.data || event);
      return await context.run(selected, async () => {
        const result = await handler(event, ...args);
        return { ...result, sfConfigProfile: selected.sfConfigProfile, sfConfigLabel: LABELS[selected.sfConfigProfile] };
      });
    } catch (e) {
      return { success: false, code: 'SF_PROFILE_ROUTE_FAILED', errMsg: e.message };
    }
  };
}
module.exports = { profile, environment, route, currentProfile, tokenId, envValue, pluginFlags, storedRoute, selectRoute, wrap, LABELS, context };
