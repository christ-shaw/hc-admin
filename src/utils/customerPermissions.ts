export function canAccessCustomerPage(pagePermissions: string[], actionPermissions: string[]): boolean {
  return (pagePermissions.includes('*') || pagePermissions.includes('/customers'))
    && ['*', 'customers:read', 'customers:write', 'customers:merge'].some(permission => actionPermissions.includes(permission));
}
