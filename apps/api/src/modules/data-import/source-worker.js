import { parentPort, workerData } from 'node:worker_threads';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import { parse } from 'csv-parse/sync';

const MAX_ROWS = 5000, MAX_COLUMNS = 30;
function bounded(rows) {
  if (!rows.length || rows.length > MAX_ROWS + 1 || rows.some(row => row.length > MAX_COLUMNS)) throw Error('SOURCE_LIMIT');
  const headers = rows.shift().map(x => String(x ?? '').replace(/^\uFEFF/, '').trim());
  if (headers.some(x => !x) || new Set(headers).size !== headers.length) throw Error('INVALID_HEADERS');
  return rows.filter(row => row.some(x => x !== '' && x != null)).map(row => {
    if (row.length !== headers.length) throw Error('INVALID_COLUMNS');
    return Object.fromEntries(headers.map((key, i) => {
      const value = row[i];
      if (value != null && !['string','number','bigint','boolean'].includes(typeof value)) throw Error('UNSUPPORTED_CELL');
      if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) throw Error('UNSAFE_NUMBER');
      return [key, value == null ? '' : String(value)];
    }));
  });
}
async function checkZip(bytes) {
  await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    let size = 0, count = 0;
    zip.on('error', reject);
    zip.on('entry', entry => {
      size += entry.uncompressedSize;
      if (++count > 2000 || size > 32 * 1024 * 1024 || (entry.generalPurposeBitFlag & 1) || /vbaProject/i.test(entry.fileName)) {
        zip.close(); reject(Error('SOURCE_LIMIT')); return;
      }
      zip.readEntry();
    });
    zip.on('end', resolve); zip.readEntry();
  }));
}
async function readSource({format, bytes, table, sheet, config}) {
  if (format === 'postgres' || format === 'mysql') {
    // Identifiers and tenant filters come exclusively from trusted server config.
    const quote = name => format === 'postgres' ? `"${name}"` : '`'+name+'`';
    const columns = config.columns.map(quote).join(',');
    const sql = `SELECT ${columns} FROM ${quote(config.table)} WHERE ${quote(config.companyColumn)} = ${format === 'postgres' ? '$1' : '?'} AND ${quote(config.branchColumn)} = ${format === 'postgres' ? '$2' : '?'} LIMIT ${MAX_ROWS+1}`;
    let client;
    try {
      let rows;
      if (format === 'postgres') {
        const {default: pg} = await import('pg');
        client = new pg.Client({...config.connection,connectionTimeoutMillis:5000,statement_timeout:8000,query_timeout:10000});
        await client.connect(); await client.query('BEGIN READ ONLY');
        const result = await client.query({text:sql,values:[config.companyValue,config.branchValue],rowMode:'array'});
        rows = result.rows; await client.query('ROLLBACK');
      } else {
        const {default:mysql} = await import('mysql2/promise');
        client = await mysql.createConnection({...config.connection,connectTimeout:5000,multipleStatements:false,decimalNumbers:false,supportBigNumbers:true,bigNumberStrings:true});
        await client.query('SET SESSION MAX_EXECUTION_TIME=8000');
        await client.query('START TRANSACTION READ ONLY');
        [rows] = await client.query({sql,values:[config.companyValue,config.branchValue],rowsAsArray:true,timeout:10000});
        await client.query('ROLLBACK');
      }
      if (rows.length > MAX_ROWS) throw Error('SOURCE_LIMIT');
      return bounded([config.columns,...rows]);
    } finally { if (client) await client.end(); }
  }
  const buffer = Buffer.from(bytes);
  if (format === 'csv') return bounded(parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer), { bom: true, skip_empty_lines: true, max_record_size: 16384 }));
  if (format === 'xlsx') {
    await checkZip(buffer);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer);
    const worksheet = sheet ? book.getWorksheet(sheet) : book.worksheets[0];
    if (!worksheet || worksheet.rowCount > MAX_ROWS + 1 || worksheet.columnCount > MAX_COLUMNS) throw Error('SOURCE_LIMIT');
    const rows = [];
    worksheet.eachRow(row => {
      const values = [];
      for (let i = 1; i <= worksheet.columnCount; i++) {
        const value = row.getCell(i).value;
        // Do not execute or trust cached results of formulas, hyperlinks or rich objects.
        if (value != null && typeof value === 'object') throw Error('UNSUPPORTED_CELL');
        values.push(value ?? '');
      }
      rows.push(values);
    });
    return bounded(rows);
  }
  if (format === 'sqlite') {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(table || '') || buffer.subarray(0,16).toString() !== 'SQLite format 3\0') throw Error('INVALID_SQLITE');
    const directory = mkdtempSync(join(tmpdir(), 'almahasib-import-'));
    let database;
    try {
      const filename = join(directory, 'source.sqlite'); writeFileSync(filename, buffer, {mode:0o600});
      database = new DatabaseSync(filename, { readOnly: true, allowExtension: false });
      database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
      const entry = database.prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?').get('table', table);
      if (!entry || /CREATE\s+VIRTUAL/i.test(entry.sql)) throw Error('INVALID_TABLE');
      const statement = database.prepare(`SELECT * FROM "${table}" LIMIT ${MAX_ROWS + 1}`);
      statement.setReadBigInts(true);
      const rows = statement.all();
      const headers = statement.columns().map(x => x.name);
      if (rows.length > MAX_ROWS) throw Error('SOURCE_LIMIT');
      return bounded([headers, ...rows.map(row => headers.map(key => {
        if (row[key] instanceof Uint8Array) throw Error('UNSUPPORTED_CELL');
        return row[key];
      }))]);
    } finally { database?.close(); rmSync(directory, { recursive: true, force: true }); }
  }
  throw Error('UNSUPPORTED_SOURCE');
}
try { parentPort.postMessage({ rows: await readSource(workerData) }); }
catch { parentPort.postMessage({ error: 'INVALID_SOURCE' }); }
