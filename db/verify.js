import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, 'products.db');
const db = new Database(DB_PATH, { fileMustExist: true });

console.log('--- Verifying Database Schema and Indexes ---');

// 1. Check EXPLAIN QUERY PLAN for global keyset query
const globalQueryNoCursor = `
  SELECT * FROM products
  ORDER BY created_at DESC, id DESC
  LIMIT 20
`;

const globalQueryWithCursor = `
  SELECT * FROM products
  WHERE (created_at < ? OR (created_at = ? AND id < ?))
  ORDER BY created_at DESC, id DESC
  LIMIT 20
`;

console.log('\nQuery: Global (No Cursor)');
const plan1 = db.prepare(`EXPLAIN QUERY PLAN ${globalQueryNoCursor}`).all();
console.log(plan1);

console.log('\nQuery: Global (With Cursor)');
const plan2 = db.prepare(`EXPLAIN QUERY PLAN ${globalQueryWithCursor}`).all(Date.now(), Date.now(), 'prod_123');
console.log(plan2);

// 2. Check EXPLAIN QUERY PLAN for filtered keyset query
const categoryQueryNoCursor = `
  SELECT * FROM products
  WHERE category = ?
  ORDER BY created_at DESC, id DESC
  LIMIT 20
`;

const categoryQueryWithCursor = `
  SELECT * FROM products
  WHERE category = ? 
    AND (created_at < ? OR (created_at = ? AND id < ?))
  ORDER BY created_at DESC, id DESC
  LIMIT 20
`;

console.log('\nQuery: Category-Filtered (No Cursor)');
const plan3 = db.prepare(`EXPLAIN QUERY PLAN ${categoryQueryNoCursor}`).all('Electronics');
console.log(plan3);

console.log('\nQuery: Category-Filtered (With Cursor)');
const plan4 = db.prepare(`EXPLAIN QUERY PLAN ${categoryQueryWithCursor}`).all('Electronics', Date.now(), Date.now(), 'prod_123');
console.log(plan4);

// 3. Simple benchmark: fetch first 10 pages sequentially, measure latency
console.log('\n--- Benchmarking Query Performance (10 consecutive pages) ---');
let cursor = null;
let totalFetchTime = 0;
const category = 'Electronics';

for (let page = 1; page <= 10; page++) {
  let query = '';
  let params = [];
  
  if (cursor) {
    query = `
      SELECT * FROM products
      WHERE category = ? 
        AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    `;
    params = [category, cursor.created_at, cursor.created_at, cursor.id];
  } else {
    query = `
      SELECT * FROM products
      WHERE category = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    `;
    params = [category];
  }

  const start = process.hrtime.bigint();
  const rows = db.prepare(query).all(...params);
  const end = process.hrtime.bigint();
  const durationMs = Number(end - start) / 1e6;
  totalFetchTime += durationMs;

  console.log(`Page ${page}: Fetched ${rows.length} products in ${durationMs.toFixed(3)} ms`);
  
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    cursor = { created_at: last.created_at, id: last.id };
  } else {
    break;
  }
}

console.log(`Average fetch time per page: ${(totalFetchTime / 10).toFixed(3)} ms`);

db.close();
