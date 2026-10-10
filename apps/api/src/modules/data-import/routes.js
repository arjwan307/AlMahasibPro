import { AppError, asyncRoute } from '../../lib/http.js';
import { readImportSource } from './sources.js';
import { assertImportScope, normalizeImportRows } from './plan.js';

export function installDataImportRoutes(app,{store,authenticate,permit,uuid}) {
  app.post('/api/v1/data-import/preview',authenticate(store),permit('company.manage'),asyncRoute(async(req,res) => {
    const body = req.body || {};
    assertImportScope(store,req.auth,body.entity,body.branchId);
    const sourceRows = await readImportSource(body.source,{companyId:req.auth.company.id,branchId:body.branchId});
    const rows = normalizeImportRows(body.entity,sourceRows,body.mapping);
    const preview = await store.createDataImportPreview(req.auth,{entity:body.entity,branchId:body.branchId,openingDate:body.openingDate,expectedBalances:body.expectedBalances,rows});
    res.status(201).json({preview});
  }));
  app.post('/api/v1/data-import/:batchId/commit',authenticate(store),permit('company.manage'),asyncRoute(async(req,res) => {
    if (typeof req.body?.previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(req.body.previewHash)) throw new AppError(400,'INVALID_APPROVAL','بصمة المعاينة مطلوبة');
    res.json({result:await store.commitDataImport(req.auth,uuid(req.params.batchId,'batchId'),req.body.previewHash)});
  }));
}
