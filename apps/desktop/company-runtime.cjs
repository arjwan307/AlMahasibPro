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
module.exports = { companyRuntimeOptions };
