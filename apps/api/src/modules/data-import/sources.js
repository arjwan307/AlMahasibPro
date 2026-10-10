import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { AppError } from '../../lib/http.js';
let activeReaders = 0;

// Source adapters return plain rows only. They never receive target credentials or a store.
export async function readImportSource(input, context) {
  if (!['csv','xlsx','sqlite','postgres','mysql'].includes(input?.format)) throw new AppError(400,'UNSUPPORTED_SOURCE','المصدر غير مدعوم');
  let config, bytes;
  if (['postgres','mysql'].includes(input.format)) {
    try { config = JSON.parse(process.env.DATA_IMPORT_SOURCES_JSON || '{}')[input.name]; } catch {}
    if (!config || config.format !== input.format || config.targetCompanyId !== context?.companyId || config.targetBranchId !== context?.branchId) throw new AppError(403,'SOURCE_NOT_ALLOWED','المصدر غير مهيأ لهذه الشركة والفرع');
    const identifier = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
    if (!identifier(config.table) || !identifier(config.companyColumn) || !identifier(config.branchColumn) || !Array.isArray(config.columns) || !config.columns.length || config.columns.length > 30 || !config.columns.every(identifier) || config.columns.includes(config.companyColumn) || config.columns.includes(config.branchColumn) || config.companyValue == null || config.branchValue == null) throw new AppError(400,'SOURCE_CONFIG_INVALID','إعدادات المصدر غير صالحة');
    if (!config.connection || ['host','user','database'].some(field=>typeof config.connection[field] !== 'string' || !config.connection[field])) throw new AppError(400,'SOURCE_CONFIG_INVALID','إعدادات اتصال المصدر غير مكتملة');
  } else {
    if (typeof input.content !== 'string' || input.content.length > 4 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content)) throw new AppError(400,'SOURCE_LIMIT','الملف غير صالح أو أكبر من الحد');
    bytes = Buffer.from(input.content, 'base64');
    if (!bytes.length) throw new AppError(400,'INVALID_SOURCE','الملف فارغ');
  }
  if (activeReaders >= 2) throw new AppError(429,'IMPORT_READER_BUSY','يوجد فحص ملفات جارٍ؛ أعد المحاولة بعد قليل');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./source-worker.js', import.meta.url), { workerData: { format: input.format, bytes, table: input.table, sheet: input.sheet, config }, env: {TEMP:tmpdir(),TMP:tmpdir()}, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    activeReaders++;
    let settled = false;
    const finish = (error, rows) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate().then(()=>activeReaders--,()=>activeReaders--); error ? reject(error) : resolve(rows); };
    const fail = () => finish(new AppError(400,'INVALID_SOURCE','تعذر قراءة الملف بأمان؛ تحقق من الصيغة والأعمدة والحدود'));
    const timer = setTimeout(fail, 15000);
    worker.once('message', result => result.error ? fail() : finish(null, result.rows));
    worker.once('error', fail); worker.once('exit', () => { if (!settled) fail(); });
  });
}
