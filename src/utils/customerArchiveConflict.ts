const messages: Record<string, string> = {
  ARCHIVE_EVIDENCE_CHANGED: '推荐资料已更新，请关闭后刷新待归档列表，重新核对并提交。',
  ARCHIVE_MEMBER_CHANGED: '归档状态或所选版本已变化，请刷新待归档列表重新选择。',
  ARCHIVE_ORDER_CHANGED: '订单已修改、已关联或不再符合归档条件，请重新扫描后核对。',
  ARCHIVE_RECOMMENDATION_CHANGED: '该客户已不在推荐结果中，请刷新后重新核对。',
  CUSTOMER_UNAVAILABLE: '目标客户已停用或合并，请重新选择客户。',
  CUSTOMER_NOT_FOUND: '目标客户不存在，请重新选择客户。',
  CUSTOMER_REFERENCE_UNAVAILABLE: '所选别名或收货档案已停用或不存在，请重新选择。',
  CUSTOMER_REFERENCE_MISMATCH: '所选别名或收货档案不属于目标客户，请重新选择。',
};

export function customerArchiveConflict(code?: string) {
  return messages[code || ''] || `归档发生冲突${code ? `（${code}）` : ''}，请重新核对。`;
}
