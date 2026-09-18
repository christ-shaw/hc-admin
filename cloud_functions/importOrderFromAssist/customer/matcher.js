const { NORMALIZATION_VERSION, normalizeName, normalizeIdentity, isCompleteIdentity, identityFingerprint } = require('./normalizers');
const { resolveCustomer } = require('./cluster');
const { CustomerError } = require('./errors');

// Scores explain candidates only. A score of 100 never substitutes for the hard rule.
async function matchIdentity(repository, identity = {}) {
  const [customers, aliases, profiles] = await Promise.all([
    repository.fetchAll('customers'), repository.fetchAll('customer_aliases'), repository.fetchAll('customer_recipient_profiles'),
  ]);
  const byId = new Map(customers.map(row => [row._id, row]));
  const groups = new Map();
  const issues = [];
  for (const row of customers) {
    try {
      const { customer } = await resolveCustomer(row._id, async id => byId.get(id));
      const group = groups.get(customer._id) || { customer, memberIds: new Set() };
      group.memberIds.add(row._id); groups.set(customer._id, group);
    } catch (error) {
      if (!(error instanceof CustomerError)) throw error;
      issues.push({ customerId: row._id, code: error.code });
    }
  }
  const observed = normalizeIdentity(identity);
  const complete = isCompleteIdentity(identity);
  const candidates = [];
  for (const { customer, memberIds } of groups.values()) {
    const evidence = [];
    const names = customers.filter(row => memberIds.has(row._id)).map(row => ({ id: row._id, name: row.displayName, kind: 'displayName' }))
      .concat(aliases.filter(row => memberIds.has(row.customerId) && row.enabled !== false).map(row => ({ id: row._id, name: row.name, kind: 'alias' })));
    const nameMatches = names.filter(row => observed.customerName && normalizeName(row.name) === observed.customerName);
    for (const row of nameMatches) evidence.push({ type: 'name_exact', objectId: row.id, source: row.kind });
    let bestProfileScore = 0;
    const exactRecipientProfileIds = [];
    for (const profile of profiles.filter(row => memberIds.has(row.customerId) && row.enabled !== false)) {
      const normalized = normalizeIdentity(profile);
      let score = 0;
      for (const [field, points] of [['phone', 30], ['address', 20], ['consignee', 10]]) {
        if (observed[field] && observed[field] === normalized[field]) {
          score += points;
          evidence.push({ type: `${field}_exact`, objectId: profile._id, source: 'recipient' });
        }
      }
      bestProfileScore = Math.max(bestProfileScore, score);
      if (complete && score === 60 && isCompleteIdentity({ ...profile, customerName: identity.customerName })) exactRecipientProfileIds.push(profile._id);
    }
    const score = (nameMatches.length ? 40 : 0) + bestProfileScore;
    if (!score) continue;
    candidates.push({ customerId: customer._id, score, reasons: [...new Set(evidence.map(item => item.type))], evidence,
      exact: nameMatches.length > 0 && exactRecipientProfileIds.length > 0, exactRecipientProfileIds });
  }
  candidates.sort((a, b) => b.score - a.score || a.customerId.localeCompare(b.customerId));
  const exact = candidates.filter(row => row.exact);
  // Corrupt clusters make uniqueness unknowable. Fail closed, retaining diagnostic IDs only.
  const corrupt = issues.some(item => item.code !== 'CUSTOMER_UNAVAILABLE');
  const status = corrupt ? 'invalid_cluster' : !complete ? 'incomplete' : exact.length > 1 ? 'ambiguous' : exact.length === 1 ? 'exact' : 'no_match';
  return { normalizationVersion: NORMALIZATION_VERSION, identityFingerprint: identityFingerprint(identity), status,
    autoLinkEligible: status === 'exact', customerId: status === 'exact' ? exact[0].customerId : null, candidates, issues };
}
module.exports = { matchIdentity };
