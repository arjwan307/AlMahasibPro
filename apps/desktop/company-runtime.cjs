const fs = require('node:fs');
const path = require('node:path');

// Keep company desktop storage, cookies, identity and port independent from
// the legacy shared launcher and cashier installations. Never import or erase
// the legacy data directory implicitly.
function companyRuntimeOptions(appData, env = process.env) {
  const port = Number(env.ALMAHASIB_COMPANY_PORT || 3213);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('منفذ تطبيق الشركات غير صالح');
  return {
    name: 'AlMahasibProCompanies',
    appId: 'com.almahasibpro.companies',
    dataDirectory: env.ALMAHASIB_COMPANY_DATA_DIR
      ? path.resolve(env.ALMAHASIB_COMPANY_DATA_DIR)
      : path.join(appData, 'AlMahasibProCompanies'),
    port,
    partition: 'persist:almahasib-company'
  };
}
function prepareCompanyRuntime(app, env = process.env) {
  const options = companyRuntimeOptions(app.getPath('appData'), env);
  const sessionDirectory = path.join(options.dataDirectory, 'Browser');
  // Electron requires overridden directories to exist before app.setPath.
  fs.mkdirSync(options.dataDirectory, { recursive: true });
  fs.mkdirSync(sessionDirectory, { recursive: true });
  app.setName(options.name);
  app.setAppUserModelId(options.appId);
  app.setPath('userData', options.dataDirectory);
  app.setPath('sessionData', sessionDirectory);
  return options;
}
async function refreshCompanyShell(session){
 await session.clearCache();
 await session.clearStorageData({storages:['serviceworkers','cachestorage']});
}
module.exports = { companyRuntimeOptions, prepareCompanyRuntime, refreshCompanyShell };
