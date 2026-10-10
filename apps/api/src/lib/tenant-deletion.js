import { AppError } from './http.js';

// Coordinates an intentional tenant deletion across the authoritative cloud store
// and an optional local store. The cloud purge is atomic and tombstoned, so the
// operation is idempotent and can be retried after a network failure without
// risking a partially deleted tenant or a resurrected company.
export async function deleteTenantEverywhere({ cloudStore, localStore = null, companyId, companyCode, actorUserId, confirm = false }) {
  if (!cloudStore) throw new AppError(500, 'STORE_UNAVAILABLE', 'مخزن البيانات غير متاح');
  if (confirm !== true) throw new AppError(400, 'CONFIRMATION_REQUIRED', 'أكد الحذف صراحة');
  const cloud = await cloudStore.deletePlatformCompany(companyId, actorUserId, { confirm: true, code: companyCode });
  let local = localStorageState(localStore, cloudStore);
  let localError = null;
  if (local === 'pending') {
    try {
      await localStore.deletePlatformCompany(companyId, actorUserId, { confirm: true, code: companyCode });
      local = 'completed';
    } catch (error) {
      localError = error.message || String(error);
    }
  } else if (local === 'noop' && localStore && localStore !== cloudStore) {
    local = 'pending';
  }
  return {
    companyId,
    code: cloud.code,
    generation: cloud.generation,
    status: local === 'pending' ? 'pending' : 'completed',
    cloud: 'completed',
    local: local === 'noop' ? 'skipped' : local,
    alreadyDeleted: cloud.alreadyDeleted === true,
    error: localError,
    deletion: cloud.deletion || cloudStore.companyDeletionTombstone?.(companyId) || null
  };
}

export async function retryTenantDeletion(options) {
  return deleteTenantEverywhere(options);
}

function localStorageState(localStore, cloudStore) {
  if (!localStore) return 'noop';
  if (localStore === cloudStore) return 'completed';
  return 'pending';
}
