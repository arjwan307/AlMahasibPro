import { AppError } from './http.js';
export function approvedCompanyCode(company, input) {
 const type=company.businessType||(company.product==='retail'?'restaurant':'company');
 const prefix={company:'co',restaurant:'re',complex:'ma'}[type];
 const code=String(input||'').trim().toLowerCase();
 if(!prefix||!new RegExp('^'+prefix+'[0-9]+$').test(code))throw new AppError(400,'INVALID_COMPANY_CODE','رمز النشاط يجب أن يكون '+(prefix||'co/re/ma')+' ثم رقم، مثل '+(prefix||'co')+'2020');
 return code;
}
