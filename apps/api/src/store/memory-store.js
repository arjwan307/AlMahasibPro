import { checkSales, salesRep, assignedSalesManager } from '../sales-workspace.js';
import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/http.js';
import { decimal, decimalString, divide, multiply, ZERO } from '../lib/decimal.js';
import { PERMISSIONS, ROLE_TEMPLATES } from '../permissions.js';

const clone = (value) => structuredClone(value);

export class MemoryStore {
