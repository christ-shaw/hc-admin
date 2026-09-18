// Only explicit document-not-found errors are absence; permissions/network errors propagate.
function notFound(error) {
  return error && (error.errCode === -502005 || /document.*(not exist|not found)|DOCUMENT_NOT_FOUND/i.test(error.message || ''));
}
function createRepository(db) {
  async function getDocById(collection, id, store = db) {
    if (!id) return null;
    try { return (await store.collection(collection).doc(id).get()).data || null; }
    catch (error) { if (notFound(error)) return null; throw error; }
  }
  async function fetchAll(collection, where = {}) {
    const rows = [];
    const query = db.collection(collection).where(where).orderBy('_id', 'asc');
    for (let skip = 0; ; skip += 100) {
      const page = (await query.skip(skip).limit(100).get()).data || [];
      rows.push(...page);
      if (page.length < 100) return rows;
    }
  }
  return { db, getDocById, fetchAll };
}
module.exports = { createRepository };
