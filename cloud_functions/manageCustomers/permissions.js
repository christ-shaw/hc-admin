const READ = ['customers:read', 'customers:write', 'customers:merge'];
const WRITE = ['customers:write'];
const SELECT = [...READ, 'orders:create', 'orders:update'];

// Reserved future actions are declared here but have no handler until their implementation stage.
// Internal-only actions deliberately have no client grant, including for wildcard roles.
const ACTION_PERMISSIONS = Object.freeze({
  list: READ, get: READ, search: SELECT,
  create: WRITE, createFromOrder: WRITE, update: WRITE, disable: WRITE, enable: WRITE,
  createAlias: WRITE, updateAlias: WRITE, disableAlias: WRITE,
  createRecipient: WRITE, updateRecipient: WRITE, disableRecipient: WRITE,
  matchIdentity: READ, ingestOrder: null, touchRecipient: null,
  listLinkCandidates: READ, resolveLinkCandidate: WRITE,
  listRelations: READ, listRelationCandidates: READ,
  confirmRelation: WRITE, rejectRelation: WRITE, removeRelation: WRITE,
  merge: ['customers:merge'], unmerge: ['customers:merge'],
  relinkOrder: ['customers:write', 'orders:update'],
  scanUnlinkedOrders: ['*'], scanNewOrders: ['*'], rebuildStats: ['*'],
});

function permissionsFor(action, scope) {
  if (!Object.prototype.hasOwnProperty.call(ACTION_PERMISSIONS, action)) return null;
  if (scope !== undefined) {
    if (scope === 'orderSuggestions' && action === 'search') return SELECT;
    if (scope !== 'orderSelection' || !['get', 'search'].includes(action)) return null;
    return SELECT;
  }
  return ACTION_PERMISSIONS[action];
}

function hasAnyPermission(role, permissions) {
  if (!permissions) return false;
  const actions = Array.isArray(role && role.actionPermissions) ? role.actionPermissions : [];
  return actions.includes('*') || permissions.some(permission => actions.includes(permission));
}

module.exports = { ACTION_PERMISSIONS, permissionsFor, hasAnyPermission };
