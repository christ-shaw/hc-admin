/** Translate SDK errors without exposing raw responses or treating every failure as a bad password. */
export function loginErrorMessage(error: unknown): string {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const text = [typeof error === 'string' ? error : '', value.category, value.code, value.error,
    value.message, value.error_description].filter(item => typeof item === 'string').join(' ').toLowerCase();
  if (/network|fetch|timeout|timed.?out|abort|网络|超时|中断/.test(text)) {
    return '登录服务连接失败或请求超时，请检查网络后重试';
  }
  if (/provider_not_enabled|login_method_disabled/.test(text)) return '账号密码登录暂不可用，请联系管理员';
  if (/too_many_requests|rate.?limit|resource_exhausted/.test(text)) return '登录尝试过于频繁，请稍后重试';
  if (/invalid_credentials|invalid_username_or_password|invalid_password|wrong_password|user_not_found|用户名或密码|密码不正确/.test(text)) {
    return '登录失败：用户名或密码错误';
  }
  return '登录暂时失败，请稍后重试；若持续失败，请联系管理员';
}
