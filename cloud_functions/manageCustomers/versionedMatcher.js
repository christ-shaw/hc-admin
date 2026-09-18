const { matchIdentity } = require('./matcher');
const { readIdentityRevision } = require('./identityRevision');
const { NORMALIZATION_VERSION } = require('./normalizers');
const { fail } = require('./errors');

// Only tag a snapshot when no identity write occurred during its collection reads.
// Never attach a newer revision to older matching data.
async function identitySnapshot(repository) {
  const collections = ['customers', 'customer_aliases', 'customer_recipient_profiles'];
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = await readIdentityRevision(repository);
    const rows = await Promise.all(collections.map(name => repository.fetchAll(name)));
    if (revision !== await readIdentityRevision(repository)) continue;
    const data = new Map(collections.map((name, index) => [name, rows[index]]));
    return { revision, fetchAll: name => Promise.resolve(data.get(name)),
      names: new Map(rows[0].map(row => [row._id, row.displayName])) };
  }
  fail('CUSTOMER_IDENTITY_CHANGED', '客户资料正在变化，请稍后重新核对');
}

async function matchSnapshot(snapshot, identity) {
  const result = await matchIdentity(snapshot, identity);
  return { ...result, identityRevision: snapshot.revision,
    candidates: result.candidates.map(row => ({ ...row, displayName: snapshot.names.get(row.customerId) || '客户已不存在' })) };
}

async function conditionalMatch(repository, payload) {
  if (Number.isSafeInteger(payload.knownIdentityRevision) && payload.knownIdentityRevision >= 0
    && payload.knownNormalizationVersion === NORMALIZATION_VERSION
    && payload.knownIdentityRevision === await readIdentityRevision(repository)) {
    return { unchanged: true, identityRevision: payload.knownIdentityRevision, normalizationVersion: NORMALIZATION_VERSION };
  }
  return matchSnapshot(await identitySnapshot(repository), payload.identity || {});
}

module.exports = { identitySnapshot, matchSnapshot, conditionalMatch };
