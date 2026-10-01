export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function requireFields(body, fields) {
  const missing = fields.filter((field) => typeof body?.[field] !== 'string' || !body[field].trim());
  if (missing.length) throw new AppError(400, 'VALIDATION_ERROR', 'حقول مطلوبة غير مكتملة', { missing });
}

export function normalizeCode(value) {
  const code = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(code)) {
    throw new AppError(400, 'INVALID_COMPANY_CODE', 'رمز الشركة يجب أن يكون 3-32 حرفًا إنجليزيًا أو رقمًا');
  }
  return code;
}

export function normalizeUsername(value) {
  const username = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username)) {
    throw new AppError(400, 'INVALID_USERNAME', 'اسم المستخدم غير صالح');
  }
  return username;
}

