/**
 * Differential tests: every query runs on dbsql and on real SQLite (sql.js) and the results
 * must match. Queries that are *meant* to behave differently from SQLite live in
 * dialect.test.js instead.
 *
 * Case fields:
 *   sql      the query
 *   ordered  true if ORDER BY makes the row order part of the expected result
 *   keys     output column positions that ORDER BY sorts on (rows that tie on them may come
 *            back in any order, as the SQL standard allows)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBoth, diffResults } from './helpers.js';

const CASES = {
  'basic projection and filters': [
    { sql: 'SELECT * FROM products' },
    { sql: 'SELECT name, price FROM products WHERE price > 20' },
    { sql: "SELECT name FROM products WHERE category = 'stationery' AND price < 3 OR stock = 0" },
    { sql: 'SELECT name FROM products WHERE price BETWEEN 4.25 AND 40' },
    { sql: 'SELECT name FROM products WHERE price NOT BETWEEN 4.25 AND 40' },
    { sql: "SELECT name FROM products WHERE name LIKE '%desk%'" },
    { sql: "SELECT name FROM products WHERE name LIKE 'B_llpoint%' OR name NOT LIKE '%e%'" },
    { sql: 'SELECT name FROM products WHERE product_id IN (1, 3, 99)' },
    { sql: 'SELECT name FROM products WHERE supplier_id NOT IN (1, 2)' },
    { sql: 'SELECT name, stock FROM products WHERE stock IS NULL OR supplier_id IS NULL' },
    { sql: 'SELECT name, price * stock AS stock_value FROM products' },
    { sql: 'SELECT name, -price, price / 2, price - 100 FROM products' },
    { sql: 'SELECT DISTINCT category FROM products' },
    { sql: 'SELECT DISTINCT city FROM customers' },
    { sql: "SELECT name, COALESCE(city, 'unknown') FROM customers" },
    { sql: 'SELECT UPPER(name), LOWER(category), LENGTH(name), ABS(price - 100) FROM products' },
    { sql: "SELECT name FROM customers WHERE name = 'Ava Chen' -- trailing comment" },
    { sql: "SELECT name FROM customers /* block */ WHERE tier <> 'gold'" },
    { sql: "SELECT name FROM customers WHERE name = 'O''Brien' OR tier = 'gold'" },
  ],

  'joins': [
    { sql: 'SELECT o.order_id, c.name FROM orders o JOIN customers c ON o.customer_id = c.customer_id' },
    { sql: 'SELECT o.order_id, c.name FROM orders o INNER JOIN customers c ON o.customer_id = c.customer_id' },
    { sql: 'SELECT c.name, o.order_id FROM customers c LEFT JOIN orders o ON c.customer_id = o.customer_id' },
    { sql: 'SELECT c.name, o.order_id FROM customers c RIGHT JOIN orders o ON c.customer_id = o.customer_id' },
    { sql: 'SELECT c.name, o.order_id FROM customers c FULL OUTER JOIN orders o ON c.customer_id = o.customer_id' },
    { sql: 'SELECT p.name, s.name FROM products p LEFT OUTER JOIN suppliers s ON p.supplier_id = s.supplier_id' },
    { sql: 'SELECT s.name, p.name FROM suppliers s LEFT JOIN products p ON s.supplier_id = p.supplier_id' },
    { sql: 'SELECT s.name, p.name FROM suppliers s FULL JOIN products p ON s.supplier_id = p.supplier_id' },
    { sql: 'SELECT s.name, p.name FROM suppliers s RIGHT OUTER JOIN products p ON s.supplier_id = p.supplier_id' },
    {
      sql: 'SELECT o.order_id, p.name, i.quantity FROM orders o ' +
        'JOIN order_items i ON o.order_id = i.order_id JOIN products p ON i.product_id = p.product_id',
    },
    {
      sql: 'SELECT c.name, o.order_id FROM customers c ' +
        "LEFT JOIN orders o ON c.customer_id = o.customer_id AND o.status = 'delivered'",
    },
    {
      sql: 'SELECT c.name, o.order_id FROM customers c ' +
        "LEFT JOIN orders o ON c.customer_id = o.customer_id WHERE o.status = 'delivered'",
    },
    { sql: 'SELECT p.name, q.name FROM products p JOIN products q ON p.price = q.price AND p.product_id < q.product_id' },
    { sql: "SELECT c.name, s.name FROM customers c, suppliers s WHERE s.country = 'Spain'" },
    {
      sql: 'SELECT c.name, o.order_id, i.product_id FROM customers c ' +
        'LEFT JOIN orders o ON c.customer_id = o.customer_id LEFT JOIN order_items i ON o.order_id = i.order_id',
    },
    {
      sql: 'SELECT p.name, i.order_id FROM orders o JOIN order_items i ON o.order_id = i.order_id ' +
        'RIGHT JOIN products p ON i.product_id = p.product_id',
    },
    {
      sql: 'SELECT c.name, o.order_id, i.product_id FROM customers c ' +
        'FULL JOIN orders o ON c.customer_id = o.customer_id FULL JOIN order_items i ON o.order_id = i.order_id',
    },
    { sql: 'SELECT c.name, o.order_id FROM customers c LEFT JOIN orders o ON 1 = 0' },
  ],

  'grouping and aggregates': [
    { sql: 'SELECT category, COUNT(*), SUM(stock), AVG(price), MIN(price), MAX(name) FROM products GROUP BY category' },
    { sql: 'SELECT COUNT(*), COUNT(discount), COUNT(DISTINCT discount), AVG(discount) FROM order_items' },
    { sql: 'SELECT city, COUNT(*) FROM customers GROUP BY city' },
    { sql: 'SELECT customer_id, COUNT(*) FROM orders GROUP BY customer_id HAVING COUNT(*) > 1' },
    {
      sql: 'SELECT order_id, SUM(quantity * unit_price) FROM order_items ' +
        'GROUP BY order_id HAVING SUM(quantity * unit_price) > 100',
    },
    { sql: 'SELECT COUNT(*), SUM(price), MAX(price), AVG(stock) FROM products WHERE price > 1000' },
    { sql: 'SELECT category, COUNT(*) FROM products WHERE price > 1000 GROUP BY category' },
    { sql: 'SELECT tier, city, COUNT(*) FROM customers GROUP BY tier, city' },
    {
      sql: 'SELECT c.name, COUNT(o.order_id) FROM customers c ' +
        'LEFT JOIN orders o ON c.customer_id = o.customer_id GROUP BY c.name',
    },
    {
      sql: 'SELECT order_id, SUM(quantity * unit_price * (1 - COALESCE(discount, 0))) FROM order_items GROUP BY order_id',
    },
    { sql: 'SELECT COUNT(DISTINCT category), COUNT(DISTINCT supplier_id), SUM(DISTINCT price) FROM products' },
    { sql: 'SELECT signup_year, MIN(name), MAX(city) FROM customers GROUP BY signup_year' },
    {
      sql: 'SELECT s.country, COUNT(p.product_id), SUM(p.stock) FROM suppliers s ' +
        'LEFT JOIN products p ON s.supplier_id = p.supplier_id GROUP BY s.country',
    },
    { sql: 'SELECT COUNT(*) FROM products HAVING COUNT(*) > 5' },
    { sql: 'SELECT category FROM products GROUP BY category HAVING MAX(price) > 100 OR MIN(stock) IS NULL' },
  ],

  'subqueries': [
    { sql: 'SELECT name FROM products WHERE price > (SELECT AVG(price) FROM products)' },
    {
      sql: 'SELECT p.name, p.category FROM products p ' +
        'WHERE p.price > (SELECT AVG(q.price) FROM products q WHERE q.category = p.category)',
    },
    { sql: 'SELECT c.name FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id)' },
    { sql: 'SELECT c.name FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id)' },
    { sql: "SELECT name FROM customers WHERE customer_id IN (SELECT customer_id FROM orders WHERE status = 'shipped')" },
    // NOT IN against a list that contains NULL can never be TRUE: the result is empty.
    { sql: 'SELECT name FROM customers WHERE customer_id NOT IN (SELECT customer_id FROM orders)' },
    {
      sql: 'SELECT name FROM customers WHERE customer_id NOT IN ' +
        '(SELECT customer_id FROM orders WHERE customer_id IS NOT NULL)',
    },
    // NOT IN / IN against an EMPTY subquery: TRUE / FALSE for every row, even when the left side is NULL.
    { sql: 'SELECT name FROM customers WHERE city NOT IN (SELECT city FROM customers WHERE 1 = 0)' },
    { sql: 'SELECT name FROM customers WHERE city IN (SELECT city FROM customers WHERE 1 = 0)' },
    {
      sql: 'SELECT c.name, (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.customer_id) AS n_orders ' +
        'FROM customers c',
    },
    { sql: 'SELECT name, (SELECT MAX(order_date) FROM orders WHERE customer_id = 999) FROM customers' },
    {
      sql: 'SELECT category, AVG(price) FROM products GROUP BY category ' +
        'HAVING AVG(price) > (SELECT AVG(price) FROM products)',
    },
    {
      sql: 'SELECT c.name FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id ' +
        'AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.order_id AND i.discount IS NOT NULL))',
    },
    {
      sql: 'SELECT p.name FROM products p WHERE p.product_id NOT IN ' +
        '(SELECT i.product_id FROM order_items i JOIN orders o ON i.order_id = o.order_id WHERE o.customer_id = 1)',
    },
    {
      sql: 'SELECT s.name FROM suppliers s WHERE (SELECT COUNT(*) FROM products p ' +
        'WHERE p.supplier_id = s.supplier_id) = 0',
    },
  ],

  'three-valued logic': [
    { sql: "SELECT name FROM customers WHERE NOT (city = 'Lisbon')" },
    { sql: "SELECT name FROM customers WHERE city = 'Lisbon' OR city IS NULL" },
    { sql: 'SELECT order_id, product_id FROM order_items WHERE NOT (discount > 0.05 AND quantity > 1)' },
    { sql: 'SELECT order_id, product_id, discount > 0.05 OR quantity > 1 FROM order_items' },
    { sql: 'SELECT order_id, product_id, discount > 0.05 AND quantity > 1 FROM order_items' },
    { sql: 'SELECT order_id, product_id FROM order_items WHERE (discount > 0.1) IS NULL' },
    { sql: 'SELECT name FROM products WHERE 1 NOT IN (2, NULL)' },
    { sql: 'SELECT name FROM products WHERE 2 IN (2, NULL)' },
    { sql: 'SELECT name FROM products WHERE supplier_id NOT IN (1, NULL)' },
    { sql: 'SELECT name FROM products WHERE stock BETWEEN NULL AND 100' },
    { sql: 'SELECT name, stock > 10 FROM products' },
    { sql: "SELECT name FROM customers WHERE city <> 'Lisbon'" },
  ],

  'order by': [
    { sql: 'SELECT name, price FROM products ORDER BY price', ordered: true, keys: [1] },
    { sql: 'SELECT category, price, name FROM products ORDER BY category, price DESC', ordered: true, keys: [0, 1] },
    { sql: 'SELECT name, price FROM products ORDER BY 2 DESC', ordered: true, keys: [1] },
    { sql: 'SELECT name, price * 2 AS doubled FROM products ORDER BY doubled', ordered: true, keys: [1] },
    { sql: 'SELECT name, stock FROM products ORDER BY stock NULLS FIRST', ordered: true, keys: [1] },
    { sql: 'SELECT name, stock FROM products ORDER BY stock DESC NULLS LAST', ordered: true, keys: [1] },
    { sql: 'SELECT name, city FROM customers ORDER BY city ASC NULLS LAST, name', ordered: true, keys: [1, 0] },
    { sql: 'SELECT name, city FROM customers ORDER BY city DESC NULLS FIRST', ordered: true, keys: [1] },
    {
      sql: 'SELECT category, COUNT(*) FROM products GROUP BY category ORDER BY COUNT(*) DESC, category',
      ordered: true,
      keys: [1, 0],
    },
    { sql: 'SELECT DISTINCT category FROM products ORDER BY category DESC', ordered: true, keys: [0] },
    { sql: 'SELECT name, tier FROM customers ORDER BY tier', ordered: true, keys: [1] },
    { sql: 'SELECT name, price FROM products ORDER BY price DESC, name', ordered: true },
    { sql: 'SELECT p.name, p.price FROM products p ORDER BY p.price, p.name', ordered: true },
  ],

  'scalar functions': [
    { sql: 'SELECT name, ROUND(price) FROM products' },
    { sql: 'SELECT name, ROUND(price, 1) FROM products' },
    { sql: 'SELECT name, ROUND(price - 50) FROM products' },
    { sql: 'SELECT category, ROUND(AVG(price), 2) FROM products GROUP BY category' },
    { sql: 'SELECT name, ROUND(-price, 1) FROM products' },
    // regression: half-way cases and values whose decimal form is not exact in binary
    {
      sql: 'SELECT ROUND(-2.5), ROUND(2.5), ROUND(-0.5), ROUND(0.15 * 0.5, 2), ROUND(-0.15 * 0.5, 2), ' +
        'ROUND(1.005, 2), ROUND(2.675, 2), ROUND(123.456, -1) FROM suppliers WHERE supplier_id = 1',
    },
    // regression: AVG must use compensated summation, or 3.025 lands on the wrong side of the tie
    { sql: "SELECT ROUND(AVG(p.price), 2) FROM products p JOIN suppliers s ON p.supplier_id = s.supplier_id WHERE p.category = 'stationery'" },
    { sql: "SELECT ROUND(AVG(price), 2), SUM(price) FROM products WHERE category = 'stationery'" },
    { sql: 'SELECT SUM(unit_price * quantity), AVG(unit_price * quantity), SUM(discount) FROM order_items' },
    // numeric text is converted when compared with a number (both engines agree here)
    { sql: "SELECT name FROM products WHERE price > '100'" },
  ],
};

for (const [group, cases] of Object.entries(CASES)) {
  test(`differential: ${group}`, async (t) => {
    for (const c of cases) {
      await t.test(c.sql, async () => {
        const r = await runBoth(c.sql);
        if (r.sqliteError) assert.fail('SQLite rejected the query: ' + r.sqliteError.message);
        if (r.engineError) assert.fail('dbsql rejected the query: ' + r.engineError.message);
        const d = diffResults(r.engine, r.sqlite, c);
        assert.equal(d, null, `${d}\n  dbsql : ${JSON.stringify(r.engine.rows)}\n  sqlite: ${JSON.stringify(r.sqlite.rows)}`);
      });
    }
  });
}
