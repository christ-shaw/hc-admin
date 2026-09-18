class CustomerError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new CustomerError(code, message); }
module.exports = { CustomerError, fail };
