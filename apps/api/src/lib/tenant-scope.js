// Ownership for serialized ERP state, including legacy settings keyed by entity UUID.
export function tenantScope(state, companyId) {
  const owned = new Set([companyId]);
  for (const value of Object.values(state)) if (value instanceof Map) for (const [id,row] of value) if (row?.companyId === companyId) owned.add(String(id));
  return (field,id,row) => {
    if (field === 'companies') return id === companyId;
    if (field === 'sessions') return owned.has(row?.userId);
    if (row?.companyId) return row.companyId === companyId;
    const parts = String(id).split(':');
    return parts[0] === companyId || field === 'salesSettings' && parts.some(part=>owned.has(part));
  };
}
