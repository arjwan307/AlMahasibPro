import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedCompanyCode } from '../../apps/api/src/lib/company-code.js';
test('developer codes identify the registered business type and require a numeric suffix',()=>{
 for(const [businessType,code] of [['company','co2020'],['restaurant','re50'],['complex','ma75']]) {
  assert.equal(approvedCompanyCode({businessType},code.toUpperCase()),code);
  assert.throws(()=>approvedCompanyCode({businessType},'company2020'));
  assert.throws(()=>approvedCompanyCode({businessType},code.slice(0,2)));
 }
 assert.throws(()=>approvedCompanyCode({businessType:'company'},'re50'));
 assert.throws(()=>approvedCompanyCode({businessType:'restaurant'},'ma75'));
});
