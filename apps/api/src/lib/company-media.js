import { AppError } from './http.js';

export function imageData(value, max = 450000) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > max || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new AppError(400, 'INVALID_IMAGE', 'اختر صورة PNG أو JPEG أو WebP بحجم مناسب');
  const type = value.slice(11, value.indexOf(';'));
  const bytes = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
  const valid = type === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : type === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
  if (!valid) throw new AppError(400, 'INVALID_IMAGE', 'محتوى الصورة غير صالح');
  return value;
}

export function invoiceDesign(body) {
  if (!body || typeof body !== 'object') throw new AppError(400, 'INVALID_DESIGN', 'بيانات التصميم غير صالحة');
  const result = {};
  for (const [key, limit] of Object.entries({ heading:120, address:500, phone:80, footer:500 })) {
    if (typeof body[key] !== 'string' || body[key].length > limit) throw new AppError(400, 'INVALID_DESIGN', 'بيانات تصميم الفاتورة أطول من المسموح');
    result[key] = body[key].trim();
  }
  if (!/^#[0-9a-f]{6}$/i.test(body.color)) throw new AppError(400, 'INVALID_DESIGN', 'لون الفاتورة غير صالح');
  result.color = body.color;
  result.layout = ['modern','classic'].includes(body.layout) ? body.layout : 'modern';
  result.showImages = body.showImages === true;
  result.logo = imageData(body.logo || '');
  return result;
}

export function invoiceAttachment(body) {
  const name=String(body?.name||'').replace(/[\\/\u0000-\u001f]/g,'_').slice(0,160);
  const data=body?.data;
  if(!name||typeof data!=='string'||data.length>2800000)throw new AppError(400,'INVALID_ATTACHMENT','اختر مرفقًا لا يتجاوز 2 ميغابايت');
  if(data.startsWith('data:application/pdf;base64,')){
    const base64=data.slice(28);
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)||Buffer.from(base64,'base64').subarray(0,5).toString()!=='%PDF-')throw new AppError(400,'INVALID_ATTACHMENT','ملف PDF غير صالح');
  }else imageData(data,2800000);
  return {name,data,uploadedAt:new Date().toISOString()};
}
