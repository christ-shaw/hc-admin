import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeCodes } from './network-diagnostics.mjs';

test('diagnostic output excludes passwords, tokens, and free-form server messages', () => {
  const result = safeCodes(JSON.stringify({ code: 200, message: 'secret-password', token: 'secret-token', data: { code: 'F024', username: 'private-user', success: false }, error: 'full sensitive server message' }));
  assert.deepEqual(result, { code: 200, 'data.code': 'F024', 'data.success': false });
});
test('parse JSONP without executing scripts and reject arbitrary JavaScript', () => {
  assert.deepEqual(safeCodes('cb({"result":{"code":300,"success":false}});'), { 'result.code': 300, 'result.success': false });
  assert.deepEqual(safeCodes('alert(document.cookie)'), {});
  assert.deepEqual(safeCodes('<html>challenge</html>'), {});
});

test('retain nested verification outcome separately from API success without retaining credentials', () => {
  assert.deepEqual(safeCodes(JSON.stringify({ Code: 'Success', Success: true, Result: {
    VerifyCode: 'F001', VerifyResult: false, certifyId: 'private-id', securityToken: 'private-token'
  } })), { Code: 'Success', Success: true, 'Result.VerifyCode': 'F001', 'Result.VerifyResult': false });
});
