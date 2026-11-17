/** Unit tests for dbsql's own behaviour: API, error reporting and parsing details. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { createDatabase, parse, tokenize, SQLError } from '../src/dbsql.js';
import { engine } from './helpers.js';

function throwsCode(sql, code, messagePart) {
  assert.throws(() => engine.run(sql), (e) => {
    assert.ok(e instanceof SQLError, 'not an SQLError: ' + e);
    assert.equal(e.code, code, `code for: ${sql} (message: ${e.message})`);
    if (messagePart) assert.match(e.message, messagePart);
    return true;
  });
}

test('result shape', () => {
  const r = engine.run('SELECT name, price AS p FROM products WHERE product_id = 1');
  assert.deepEqual(r, { columns: ['name', 'p'], rows: [['Ballpoint Pen', 1.5]], warnings: [] });
});

test('column headers for expressions', () => {
  const r = engine.run('SELECT COUNT(*), MAX(p.price), UPPER(p.name), p.price * 2 FROM products p GROUP BY p.name, p.price');
  assert.deepEqual(r.columns, ['COUNT(*)', 'MAX(p.price)', 'UPPER(p.name)', 'p.price*2']);
});

test('table.* and multiple stars', () => {
  const r = engine.run('SELECT s.*, p.name FROM suppliers s JOIN products p ON s.supplier_id = p.supplier_id');
  assert.deepEqual(r.columns, ['supplier_id', 'name', 'country', 'name']);
});

test('identifiers and keywords are case-insensitive', () => {
  const r = engine.run('select NAME from PRODUCTS where Product_ID = 2');
  assert.deepEqual(r.rows, [['Notebook A5']]);
});

test('quoted identifiers', () => {
  const r = engine.run('SELECT "name" FROM "products" "p" WHERE "p"."product_id" = 3');
  assert.deepEqual(r.rows, [['Office Chair']]);
});

test('typographic quotes are normalised', () => {
  const r = engine.run('SELECT name FROM customers WHERE city = ‘Braga’');
  assert.deepEqual(r.rows, [['Emma Novak']]);
});

test('trailing semicolons are accepted', () => {
  assert.equal(engine.run('SELECT name FROM suppliers;;').rows.length, 4);
});

test('NULLS FIRST / NULLS LAST', () => {
  const first = engine.run('SELECT stock FROM products ORDER BY stock NULLS FIRST').rows.map((r) => r[0]);
  assert.equal(first[0], null);
  const last = engine.run('SELECT stock FROM products ORDER BY stock DESC NULLS LAST').rows.map((r) => r[0]);
  assert.equal(last[last.length - 1], null);
  assert.equal(last[0], 500);
});

test('syntax errors carry a code and a hint', () => {
  throwsCode('', 'SYNTAX', /empty/);
  throwsCode('FROM products SELECT name', 'SYNTAX', /must start with SELECT/);
  throwsCode('SELECT name WHERE price > 1 FROM products', 'SYNTAX', /Expected FROM/);
  throwsCode('SELECT category FROM products GROUP BY category WHERE price > 1', 'SYNTAX', /WHERE is out of order/);
  throwsCode('SELECT name FROM products WHERE name = \'abc', 'SYNTAX', /Unterminated/);
  throwsCode('SELECT name FROM products p JOIN suppliers s', 'SYNTAX', /JOIN without ON/);
  throwsCode('SELECT name FROM products WHERE price BETWEEN 1', 'SYNTAX', /Expected AND/);
  throwsCode('SELECT SUM(*) FROM products', 'SYNTAX', /only COUNT/);
  throwsCode('SELECT name FROM products ORDER BY name NULLS MIDDLE', 'SYNTAX', /FIRST or LAST/);
  throwsCode('SELECT name FROM products WHERE price # 2', 'SYNTAX', /Unexpected character/);
  throwsCode('SELECT name price stock FROM products', 'SYNTAX', /Expected FROM/);
  try { engine.run('SELECT name FROM products p JOIN suppliers s'); } catch (e) { assert.ok(e.hint.length > 0); }
});

test('unsupported features are reported as such', () => {
  throwsCode('SELECT name FROM products UNION SELECT name FROM suppliers', 'UNSUPPORTED', /UNION/);
  throwsCode('SELECT name FROM products LIMIT 3', 'UNSUPPORTED', /LIMIT/);
});

test('name resolution errors', () => {
  throwsCode('SELECT name FROM nope', 'NAME', /No table named "nope"/);
  throwsCode('SELECT nope FROM products', 'NAME', /Unknown column "nope"/);
  throwsCode('SELECT p.nope FROM products p', 'NAME', /has no column "nope"/);
  throwsCode('SELECT x.name FROM products p', 'NAME', /Unknown table or alias "x"/);
  throwsCode('SELECT name FROM products p JOIN suppliers s ON p.supplier_id = s.supplier_id', 'NAME', /ambiguous/);
  throwsCode('SELECT p.name FROM products p JOIN products p ON 1 = 1', 'NAME', /used twice/);
  throwsCode('SELECT FOO(name) FROM products', 'NAME', /Unknown function FOO/);
});

test('semantic errors', () => {
  throwsCode('SELECT name FROM products WHERE COUNT(*) > 1', 'SEMANTIC', /cannot be used here/);
  throwsCode('SELECT name FROM products HAVING price > 1', 'SEMANTIC', /HAVING without GROUP BY/);
  throwsCode('SELECT name FROM products ORDER BY 3', 'SEMANTIC', /out of range/);
});

test('aggregate helpers: STDDEV and VARIANCE (sample)', () => {
  const r = engine.run('SELECT VARIANCE(quantity), STDDEV(quantity) FROM order_items WHERE order_id = 1001');
  assert.deepEqual(r.rows, [[24.5, Math.sqrt(24.5)]]);
});

test('SUM and AVG use compensated summation (0.1 added ten times is exactly 1, as in SQLite)', async () => {
  const db = createDatabase({ t: { columns: ['x'], rows: Array.from({ length: 10 }, () => [0.1]) } });
  assert.deepEqual(db.run('SELECT SUM(x), AVG(x) FROM t').rows, [[1, 0.1]]);
  const SQL = await initSqlJs();
  const s = new SQL.Database();
  s.run('CREATE TABLE t (x REAL)');
  for (let i = 0; i < 10; i++) s.run('INSERT INTO t VALUES (0.1)');
  assert.deepEqual(s.exec('SELECT SUM(x), AVG(x) FROM t')[0].values, [[1, 0.1]]);
});

test('ROUND rounds half away from zero', () => {
  const db = createDatabase({ t: { columns: ['x'], rows: [[-2.5], [2.5], [-0.075], [1e300], [null]] } });
  assert.deepEqual(db.run('SELECT ROUND(x), ROUND(x, 2) FROM t').rows,
    [[-3, -2.5], [3, 2.5], [-0, -0.07], [1e300, 1e300], [null, null]]);
});

test('numeric literals with an exponent', () => {
  const r = engine.run('SELECT 1e3, 2.5E-1, .5e1 FROM suppliers WHERE supplier_id = 1');
  assert.deepEqual(r.rows, [[1000, 0.25, 5]]);
});

test('IN and scalar subqueries must return exactly one column (SQLite rejects them too)', () => {
  throwsCode('SELECT product_id FROM products WHERE product_id IN (SELECT order_id, product_id FROM order_items)',
    'SEMANTIC', /exactly one column/);
  throwsCode('SELECT name FROM products WHERE price = (SELECT price, stock FROM products WHERE product_id = 1)',
    'SEMANTIC', /exactly one column/);
});

test('NVL is an alias of COALESCE', () => {
  const r = engine.run("SELECT NVL(city, '-') FROM customers WHERE customer_id = 3");
  assert.deepEqual(r.rows, [['-']]);
});

test('parse() and tokenize() are exported for tooling', () => {
  assert.equal(tokenize('SELECT 1').length, 3);
  const ast = parse('SELECT a FROM t WHERE b > 1 ORDER BY a DESC NULLS FIRST');
  assert.equal(ast.from[0].table, 't');
  assert.deepEqual(ast.order[0], { e: { t: 'col', tbl: null, name: 'a' }, dir: 'desc', nulls: 'first' });
});

test('createDatabase validates its input', () => {
  assert.throws(() => createDatabase(null), TypeError);
  assert.throws(() => createDatabase({ t: { columns: ['a'] } }), TypeError);
  assert.throws(() => createDatabase({ t: { columns: ['a', 'b'], rows: [[1]] } }), TypeError);
});

test('the engine never mutates the input tables', () => {
  const tables = { t: { columns: ['a', 'b'], rows: [[2, null], [1, 'x']] } };
  const snapshot = JSON.stringify(tables);
  const db = createDatabase(tables);
  db.run('SELECT a, b FROM t ORDER BY a');
  db.run('SELECT a FROM t GROUP BY a');
  assert.equal(JSON.stringify(tables), snapshot);
});
