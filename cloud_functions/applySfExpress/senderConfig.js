'use strict';
const COLLECTION = 'system_config';
const FIELDS = ['contact', 'tel', 'company', 'country', 'province', 'city', 'county', 'address'];
function route(profile, env) {
  if (!['hongcheng', 'huichuan'].includes(profile)) throw new Error('请选择鸿城或汇川');
  if (!['sandbox', 'production'].includes(env)) throw new Error('请选择生产或沙箱环境');
  return `sf_senders_${profile}_${env}`;
}
function normalizeMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('寄件人配置格式无效');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 100) throw new Error('请配置 1–100 位人员的寄件信息');
  const map = Object.create(null);
  for (const [key, raw] of entries) {
    const person = String(key).trim().toLowerCase();
    if (!person || /[.$]/.test(person) || person.length > 60 || map[person]) throw new Error('人员标识为空、重复或含无效字符');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`人员 ${key} 的寄件信息无效`);
    const sender = Object.fromEntries(FIELDS.map(field => [field, String(raw[field] ?? '').trim()]));
    sender.country ||= 'CN';
    if (!sender.contact || !sender.address) throw new Error(`人员 ${key} 请填写寄件人姓名和详细地址`);
    if (!/^\d{6,20}$/.test(sender.tel)) throw new Error(`人员 ${key} 的寄件电话应为 6–20 位数字`);
    if (Object.values(sender).some(text => text.length > 500)) throw new Error('寄件信息内容过长');
    map[person] = sender;
  }
  return map;
}
async function readDocument(db, profile, env) {
  try { return (await db.collection(COLLECTION).doc(route(profile, env)).get()).data || null; }
  catch (error) {
    if (/document.*(?:not exist|not found)|does not exist|DOCUMENT_NOT_FOUND/i.test(String(error.message || ''))) return null;
    throw error;
  }
}
async function read(db, profile, env) {
  const doc = await readDocument(db, profile, env);
  return { success: true, profile, env, initialized: !!doc, senderMap: doc ? normalizeMap(doc.senderMap) : {}, revision: doc?.revision || 0, updatedAt: doc?.updatedAt || '' };
}
async function save(db, payload, user) {
  const id = route(payload.profile, payload.env);
  const senderMap = normalizeMap(payload.senderMap);
  if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0) throw new Error('请先读取寄件人配置后再保存');
  const tx = await db.startTransaction();
  try {
    const existing = await readDocument(tx, payload.profile, payload.env);
    const revision = existing?.revision || 0;
    if (revision !== payload.expectedRevision) throw new Error('寄件人配置已被其他管理员修改，请重新加载后再保存');
    const data = { profile: payload.profile, env: payload.env, senderMap, revision: revision + 1, updatedAt: new Date().toISOString(), updatedBy: user.id };
    if (existing) await tx.collection(COLLECTION).doc(id).update({ data });
    else await tx.collection(COLLECTION).add({ data: { _id: id, ...data } });
    await tx.commit();
    return { success: true, initialized: true, ...data };
  } catch (error) { try { await tx.rollback(); } catch (_) {} throw error; }
}
async function resolve(db, profile, env, person, fallback) {
  const doc = await readDocument(db, profile, env);
  if (!doc) return fallback();
  const map = normalizeMap(doc.senderMap);
  const sender = map[String(person || '').trim().toLowerCase()];
  if (!sender) throw new Error(`未配置人员「${person || ''}」的顺丰寄件人信息`);
  return sender;
}
module.exports = { route, normalizeMap, read, save, resolve };
