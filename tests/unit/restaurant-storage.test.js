import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('restaurant shifts persist separately for each company and cashier', () => {
  const source=fs.readFileSync(new URL('../../public/restaurant-pos.js',import.meta.url),'utf8');
  const names=['tenantKey','companyGet','companySet','scopedCashKey','cashState','saveCash'];
  const fragments=source.split(/\r?\n/).filter(line=>names.some(name=>line.startsWith('const '+name+'=')||line.startsWith('function '+name+'('))).join('\n');
  const records=new Map();
  const open=(companyScope,cashierId)=>{
    const context=vm.createContext({companyScope,cashierId,cashKey:'hawa_dijla_cash_shift',legacyGet:key=>records.get(key)||null,legacySet:(key,value)=>records.set(key,value),renderCash:()=>{}});
    vm.runInContext(fragments,context);
    return context;
  };
  const a=open('company-a','1');
  a.saveCash({open:true,opening:500,sales:[],expenses:[]});
  assert.equal(open('company-a','1').cashState().opening,500);
  assert.equal(open('company-b','1').cashState().open,false);
  assert.equal(open('company-a','2').cashState().open,false);
  records.set('hawa_dijla_cash_shift_1',JSON.stringify({open:true,opening:900}));
  assert.equal(open('company-b','1').cashState().open,false);
});
