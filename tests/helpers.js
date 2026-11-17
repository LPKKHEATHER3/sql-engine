/**
 * Test helpers: load the sample database into both dbsql and a real SQLite (sql.js),
 * run the same SQL on both, and compare results.
 */
import initSqlJs from 'sql.js';
import { createDatabase } from '../src/dbsql.js';
import { SHOP_TABLES } from '../data/shop.js';

export const engine = createDatabase(SHOP_TABLES);

let sqlitePromise = null;

/** Returns a sql.js Database with the same tables and rows as SHOP_TABLES. */
export function getSqlite() {
  if (!sqlitePromise) {
    sqlitePromise = initSqlJs().then((SQL) => {
      const db = new SQL.Database();
      for (const [name, def] of Object.entries(SHOP_TABLES)) {
        const cols = def.columns.map((c, i) => `${c} ${def.types[i]}`).join(', ');
        db.run(`CREATE TABLE ${name} (${cols}, PRIMARY KEY (${def.primaryKey.join(', ')}))`);
        const stmt = db.prepare(`INSERT INTO ${name} VALUES (${def.columns.map(() => '?').join(', ')})`);
        for (const row of def.rows) stmt.run(row);
        stmt.free();
      }
      return db;
    });
  }
  return sqlitePromise;
}

export function runSqlite(db, sql) {
  const res = db.exec(sql);
  if (res.length === 0) {
    // exec() returns nothing for an empty result; prepare() still knows the column count.
    const stmt = db.prepare(sql);
    const columns = stmt.getColumnNames();
    stmt.free();
    return { columns, rows: [] };
  }
  return { columns: res[0].columns, rows: res[0].values };
}

/**
 * Normalise one value for comparison.
 * - Booleans become 1/0: dbsql returns true/false for predicates in SELECT, SQLite returns 1/0.
 *   This is a representation difference only (see README, "Dialect").
 * - Numbers are compared to 12 significant digits, because SQLite and JavaScript may sum
 *   floating-point values in a different order.
 */
export function norm(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number(v.toPrecision(12));
  return v;
}

const rowKey = (r) => JSON.stringify(r);

/**
 * Compare two results.
 * @param {{ordered?: boolean, keys?: number[]}} opts
 *   ordered=false: compare as multisets of rows.
 *   ordered=true with keys: the multisets must match AND the sequence of ORDER BY key tuples
 *     (output column positions in `keys`) must match. Rows whose keys tie may appear in any
 *     order, because SQL leaves the order of ties unspecified.
 *   ordered=true without keys: rows must match exactly in sequence.
 * @returns {string|null} a description of the first difference, or null if equal.
 */
export function diffResults(a, b, opts = {}) {
  if (a.columns.length !== b.columns.length) {
    return `column count differs: ${a.columns.length} vs ${b.columns.length}`;
  }
  const ra = a.rows.map((r) => r.map(norm));
  const rb = b.rows.map((r) => r.map(norm));
  if (ra.length !== rb.length) return `row count differs: ${ra.length} vs ${rb.length}`;
  const sa = ra.map(rowKey).sort(), sb = rb.map(rowKey).sort();
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return `row sets differ: ${sa[i]} vs ${sb[i]}`;
  }
  if (opts.ordered) {
    const pick = opts.keys ? (r) => rowKey(opts.keys.map((k) => r[k])) : rowKey;
    for (let i = 0; i < ra.length; i++) {
      if (pick(ra[i]) !== pick(rb[i])) return `order differs at row ${i}: ${pick(ra[i])} vs ${pick(rb[i])}`;
    }
  }
  return null;
}

/** Run `sql` on both engines; returns {engine, sqlite, engineError, sqliteError}. */
export async function runBoth(sql, engineOptions) {
  const db = await getSqlite();
  const out = {};
  try { out.engine = engine.run(sql, engineOptions); } catch (e) { out.engineError = e; }
  try { out.sqlite = runSqlite(db, sql); } catch (e) { out.sqliteError = e; }
  return out;
}
