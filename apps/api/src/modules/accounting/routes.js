import { asyncRoute } from '../../lib/http.js';

export function installAccountingRoutes(app,{store,authenticate,permit}) {
  const transaction=callback=>store.transaction?store.transaction(callback):callback();
  app.get('/api/v1/accounting/openings',authenticate(store),permit('accounting.read'),asyncRoute(async(req,res)=>res.json({openings:await store.listOpeningJournals(req.auth)})));
  app.post('/api/v1/accounting/openings',authenticate(store),permit('accounting.post'),asyncRoute(async(req,res)=>res.status(201).json({opening:await transaction(()=>store.saveOpeningJournal(req.auth,req.body||{}))})));
  app.put('/api/v1/accounting/openings/:id',authenticate(store),permit('accounting.post'),asyncRoute(async(req,res)=>res.json({opening:await transaction(()=>store.saveOpeningJournal(req.auth,req.body||{},req.params.id))})));
  app.post('/api/v1/accounting/openings/:id/approve',authenticate(store),permit('company.manage'),asyncRoute(async(req,res)=>res.json({opening:await transaction(()=>store.approveOpeningJournal(req.auth,req.params.id))})));
  app.post('/api/v1/accounting/openings/:id/cancel',authenticate(store),permit('accounting.post'),asyncRoute(async(req,res)=>res.json({opening:await transaction(()=>store.cancelOpeningJournal(req.auth,req.params.id,req.body?.reason))})));
  app.get('/api/v1/accounting/reports',authenticate(store),permit('accounting.read'),asyncRoute(async(req,res)=>res.json(await store.accountingReport(req.auth,req.query))));
  app.post('/api/v1/accounting/journals/:id/cashflow',authenticate(store),permit('accounting.post'),asyncRoute(async(req,res)=>res.json({journal:await transaction(()=>store.classifyCashFlow(req.auth,req.params.id,req.body?.category,req.body?.reason))})));
}
