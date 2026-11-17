/**
 * Intentional differences from SQLite.
 *
 * dbsql follows standard SQL / Oracle-style semantics where SQLite is permissive or uses its
 * own conventions. Each test pins down dbsql's behaviour AND checks that SQLite really does
 * behave differently, so this file doubles as executable documentation of the dialect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, SQLError } from '../src/dbsql.js';
import { SHOP_TABLES } from '../data/shop.js';
import { engine, getSqlite, runSqlite, diffResults } from './helpers.js';

async function sqlite(sql) { return runSqlite(await getSqlite(), sql); }

function throwsCode(fn, code) {
  assert.throws(fn, (e) => e instanceof SQLError && e.code === code, `expected SQLError with code ${code}`);
}

test('strict mode: `= NULL` is rejected (SQLite silently returns no rows)', async () => {
  const sql = 'SELECT name FROM customers WHERE city = NULL';
  throwsCode(() => engine.run(sql), 'STRICT_NULL_COMPARISON');
  assert.deepEqual((await sqlite(sql)).rows, []);
});

test('non-strict mode: `= NULL` matches SQLite and reports a warning', async () => {
  const sql = 'SELECT name FROM customers WHERE city <> NULL';
  const lenient = createDatabase(SHOP_TABLES, { strict: false });
  const r = lenient.run(sql);
  assert.equal(diffResults(r, await sqlite(sql)), null);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'STRICT_NULL_COMPARISON');
  // the per-call option overrides the database default
  assert.equal(engine.run(sql, { strict: false }).warnings.length, 1);
});

test('GROUP BY: a bare non-aggregated column is an error (SQLite picks an arbitrary row)', async () => {
  const sql = 'SELECT category, name, COUNT(*) FROM products GROUP BY category';
  throwsCode(() => engine.run(sql), 'GROUP_BY');
  assert.equal((await sqlite(sql)).rows.length, 3);
});

test('GROUP BY: SELECT * is an error (SQLite allows it)', async () => {
  const sql = 'SELECT * FROM products GROUP BY category';
  throwsCode(() => engine.run(sql), 'GROUP_BY');
  assert.equal((await sqlite(sql)).rows.length, 3);
});

test('GROUP BY: ORDER BY a non-grouped column is an error', async () => {
  const sql = 'SELECT category, COUNT(*) FROM products GROUP BY category ORDER BY name';
  throwsCode(() => engine.run(sql), 'GROUP_BY');
  assert.equal((await sqlite(sql)).rows.length, 3);
});

test('a scalar subquery returning several rows is an error (SQLite uses the first row)', async () => {
  const sql = 'SELECT name FROM products WHERE price = (SELECT price FROM products WHERE category = \'stationery\')';
  throwsCode(() => engine.run(sql), 'RUNTIME');
  await sqlite(sql);   // SQLite accepts it
});

test('`/` is always exact division (SQLite truncates integer / integer)', async () => {
  const sql = 'SELECT quantity / 2 FROM order_items WHERE order_id = 1001 AND product_id = 2';
  assert.deepEqual(engine.run(sql).rows, [[1.5]]);
  assert.deepEqual((await sqlite(sql)).rows, [[1]]);
});

test('`||` treats NULL as an empty string, like Oracle (SQLite returns NULL)', async () => {
  const sql = "SELECT name || ' / ' || city FROM customers WHERE customer_id = 3";
  assert.deepEqual(engine.run(sql).rows, [['Chloe Martin / ']]);
  assert.deepEqual((await sqlite(sql)).rows, [[null]]);
});

test('default NULL ordering: NULLs sort as the largest value (SQLite sorts them as the smallest)', async () => {
  const asc = engine.run('SELECT city FROM customers ORDER BY city').rows.map((r) => r[0]);
  assert.deepEqual(asc.slice(-2), [null, null], 'ASC puts NULLs last');
  const desc = engine.run('SELECT city FROM customers ORDER BY city DESC').rows.map((r) => r[0]);
  assert.deepEqual(desc.slice(0, 2), [null, null], 'DESC puts NULLs first');
  const sAsc = (await sqlite('SELECT city FROM customers ORDER BY city')).rows.map((r) => r[0]);
  assert.deepEqual(sAsc.slice(0, 2), [null, null], 'SQLite puts NULLs first on ASC');
});

test('comparing a number with non-numeric text is a type error (SQLite silently compares them as text)', async () => {
  // SQLite applies the column's TEXT affinity to 73 and compares '2025-01-05' > '73' as strings.
  const sql = 'SELECT order_id FROM orders WHERE order_date > 73';
  assert.throws(() => engine.run(sql), (e) => e instanceof SQLError && e.code === 'TYPE');
  assert.deepEqual((await sqlite(sql)).rows, []);
  throwsCode(() => engine.run("SELECT name FROM products WHERE price IN ('cheap', 1.5)"), 'TYPE');
});

test('predicates in SELECT return true/false (SQLite returns 1/0)', async () => {
  const sql = 'SELECT price > 100 FROM products WHERE product_id = 3';
  assert.deepEqual(engine.run(sql).rows, [[true]]);
  assert.deepEqual((await sqlite(sql)).rows, [[1]]);
});

test('ties in ORDER BY keep their input order (stable sort); SQL leaves this unspecified', () => {
  const r = engine.run('SELECT product_id, price FROM products WHERE price = 4.25 ORDER BY price');
  assert.deepEqual(r.rows.map((x) => x[0]), [2, 8]);
});
