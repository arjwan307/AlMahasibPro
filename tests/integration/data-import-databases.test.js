import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readImportSource } from '../../apps/api/src/modules/data-import/sources.js';

// Opt in only with independently provisioned read-only test sources. Each source
// must contain the expected rows for its configured company/branch, and additional
// rows for another company and branch to verify the mandatory filters.
for (const format of ['postgres','mysql']) {
  test(`${format} configured read-only source returns only the selected tenant and branch`,{skip:!process.env.TEST_DATA_IMPORT_SOURCES_JSON},async()=>{
    const sources=JSON.parse(process.env.TEST_DATA_IMPORT_SOURCES_JSON);
    const config=sources[format];
    assert.ok(config,`Missing ${format} isolated test source`);
    assert.ok(Array.isArray(config.expectedRows),'expectedRows fixture is required');
    const before=process.env.DATA_IMPORT_SOURCES_JSON;
    try {
      process.env.DATA_IMPORT_SOURCES_JSON=JSON.stringify({test:config});
      const rows=await readImportSource({format,name:'test'},{companyId:config.targetCompanyId,branchId:config.targetBranchId});
      assert.deepEqual(rows.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),config.expectedRows.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
    }finally{if(before===undefined)delete process.env.DATA_IMPORT_SOURCES_JSON;else process.env.DATA_IMPORT_SOURCES_JSON=before;}
  });
}
