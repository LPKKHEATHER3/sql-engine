/**
 * Differential fuzz test: generate random queries from a grammar subset, run each on dbsql
 * and on SQLite, and require identical results.
 *
 * The generator only produces queries whose meaning is the same in both dialects (see
 * dialect.test.js for the intentional differences), e.g. ORDER BY always states NULLS
 * FIRST/LAST, and `= NULL` is never generated.
 *
 *   FUZZ_SEED=42 FUZZ_ROUNDS=5000 node tests/fuzz.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHOP_TABLES } from '../data/shop.js';
import { runBoth, diffResults } from './helpers.js';

const SEED = Number(process.env.FUZZ_SEED || 20251116);
const ROUNDS = Number(process.env.FUZZ_ROUNDS || 2000);

/* Deterministic PRNG (mulberry32), so a failing seed can be replayed exactly. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Column types and foreign-key links of the sample schema. */
const TABLES = {};
for (const [name, def] of Object.entries(SHOP_TABLES)) {
  TABLES[name] = def.columns.map((c, i) => ({ name: c, type: def.types[i] === 'TEXT' ? 'text' : 'num', idx: i }));
}
const LINKS = [
  ['orders', 'customer_id', 'customers', 'customer_id'],
  ['products', 'supplier_id', 'suppliers', 'supplier_id'],
  ['order_items', 'order_id', 'orders', 'order_id'],
  ['order_items', 'product_id', 'products', 'product_id'],
];

/* Literal pools: real values from the data plus a few that match nothing. */
function valuesOf(table, col) {
  const def = SHOP_TABLES[table];
  const i = def.columns.indexOf(col);
  return [...new Set(def.rows.map((r) => r[i]).filter((v) => v !== null))];
}

function makeGen(rand) {
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const chance = (p) => rand() < p;
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  let aliasCounter = 0;
  const newAlias = (table) => table[0] + (aliasCounter++);

  function literal(table, col, type) {
    const pool = valuesOf(table, col);
    if (type === 'num') {
      if (chance(0.15)) return String(int(-5, 600));
      return String(pick(pool));
    }
    if (chance(0.1)) return "'zzz'";
    return "'" + String(pick(pool)).replace(/'/g, "''") + "'";
  }

  function likePattern(table, col) {
    const s = String(pick(valuesOf(table, col)));
    const k = int(0, Math.max(0, s.length - 1));
    const variants = [
      s.slice(0, k + 1) + '%',
      '%' + s.slice(k, k + 2) + '%',
      '%' + s.slice(-2),
      s.slice(0, 1) + '_' + s.slice(2, 4) + '%',
      '%',
      s.toUpperCase(),
    ];
    return "'" + pick(variants).replace(/'/g, "''") + "'";
  }

  /* scope: [{alias, table}] visible to the current query (including outer queries). */
  function colRef(scope, type) {
    const cands = [];
    for (const s of scope) for (const c of TABLES[s.table]) if (!type || c.type === type) cands.push({ ...s, c });
    const x = pick(cands);
    return { sql: x.alias + '.' + x.c.name, table: x.table, col: x.c.name, type: x.c.type };
  }

  function linkCondition(inner, outerScope) {
    // A correlation predicate between the subquery's table and some outer table, if linked.
    const opts = [];
    for (const o of outerScope) {
      for (const [a, ac, b, bc] of LINKS) {
        if (a === inner.table && b === o.table) opts.push(`${inner.alias}.${ac} = ${o.alias}.${bc}`);
        if (b === inner.table && a === o.table) opts.push(`${inner.alias}.${bc} = ${o.alias}.${ac}`);
      }
    }
    return opts.length ? pick(opts) : null;
  }

  function subquerySource(outerScope, depth) {
    const table = pick(Object.keys(TABLES));
    const alias = newAlias(table);
    const inner = { alias, table };
    const conds = [];
    const corr = chance(0.7) ? linkCondition(inner, outerScope) : null;
    if (corr) conds.push(corr);
    if (chance(0.5)) conds.push(predicate([inner, ...outerScope], depth + 1));
    return { inner, where: conds.length ? ' WHERE ' + conds.join(' AND ') : '' };
  }

  function predicate(scope, depth = 0) {
    const r = rand();
    if (depth < 2 && r < 0.12) return `(${predicate(scope, depth + 1)} AND ${predicate(scope, depth + 1)})`;
    if (depth < 2 && r < 0.22) return `(${predicate(scope, depth + 1)} OR ${predicate(scope, depth + 1)})`;
    if (depth < 2 && r < 0.28) return `NOT (${predicate(scope, depth + 1)})`;
    const kind = rand();
    const c = colRef(scope);
    const not = chance(0.3) ? 'NOT ' : '';
    if (kind < 0.25) return `${c.sql} ${pick(['=', '<>', '<', '>', '<=', '>='])} ${literal(c.table, c.col, c.type)}`;
    if (kind < 0.33) {
      const d = colRef(scope, c.type);
      return `${c.sql} ${pick(['=', '<>', '<', '>='])} ${d.sql}`;
    }
    if (kind < 0.42) return `${c.sql} IS ${not}NULL`;
    if (kind < 0.5 && c.type === 'num') {
      const a = literal(c.table, c.col, 'num'), b = literal(c.table, c.col, 'num');
      return `${c.sql} ${not}BETWEEN ${a} AND ${b}`;
    }
    if (kind < 0.58) {
      const items = [];
      for (let k = int(1, 3); k > 0; k--) items.push(literal(c.table, c.col, c.type));
      if (chance(0.25)) items.push('NULL');
      return `${c.sql} ${not}IN (${items.join(', ')})`;
    }
    if (kind < 0.66 && c.type === 'text') return `${c.sql} ${not}LIKE ${likePattern(c.table, c.col)}`;
    if (depth >= 2) return `${c.sql} IS NOT NULL`;
    if (kind < 0.78) {
      // [NOT] IN (subquery) over a column of the same type
      const { inner, where } = subquerySource(scope, depth);
      const cands = TABLES[inner.table].filter((x) => x.type === c.type);
      if (!cands.length) return `${c.sql} IS NULL`;
      return `${c.sql} ${not}IN (SELECT ${inner.alias}.${pick(cands).name} FROM ${inner.table} ${inner.alias}${where})`;
    }
    if (kind < 0.9) {
      const { inner, where } = subquerySource(scope, depth);
      return `${not}EXISTS (SELECT 1 FROM ${inner.table} ${inner.alias}${where})`;
    }
    // comparison with a scalar aggregate subquery (always exactly one row)
    const { inner, where } = subquerySource(scope, depth);
    const nums = TABLES[inner.table].filter((x) => x.type === 'num');
    const left = colRef(scope, 'num');
    const agg = pick(['AVG', 'MIN', 'MAX', 'SUM', 'COUNT']);
    return `${left.sql} ${pick(['<', '>', '=', '<>'])} (SELECT ${agg}(${inner.alias}.${pick(nums).name}) FROM ${inner.table} ${inner.alias}${where})`;
  }

  function fromClause() {
    const first = pick(Object.keys(TABLES));
    const scope = [{ alias: newAlias(first), table: first }];
    let sql = `${first} ${scope[0].alias}`;
    for (let n = int(0, 2); n > 0; n--) {
      const opts = [];
      for (const s of scope) {
        for (const [a, ac, b, bc] of LINKS) {
          if (a === s.table) opts.push({ table: b, on: (al) => `${s.alias}.${ac} = ${al}.${bc}` });
          if (b === s.table) opts.push({ table: a, on: (al) => `${al}.${ac} = ${s.alias}.${bc}` });
        }
      }
      const o = pick(opts);
      const alias = newAlias(o.table);
      let on = o.on(alias);
      if (chance(0.2)) on += ' AND ' + predicate([...scope, { alias, table: o.table }], 2);
      sql += ` ${pick(['JOIN', 'INNER JOIN', 'LEFT JOIN', 'LEFT OUTER JOIN', 'RIGHT JOIN', 'FULL OUTER JOIN', 'FULL JOIN'])} ${o.table} ${alias} ON ${on}`;
      scope.push({ alias, table: o.table });
    }
    return { sql, scope };
  }

  function orderBy(nCols) {
    const keys = [];
    const parts = [];
    for (let k = int(1, Math.min(2, nCols)); k > 0; k--) {
      const pos = int(1, nCols);
      if (keys.includes(pos - 1)) continue;
      keys.push(pos - 1);
      parts.push(`${pos} ${pick(['ASC', 'DESC'])} NULLS ${pick(['FIRST', 'LAST'])}`);
    }
    return { sql: ' ORDER BY ' + parts.join(', '), keys };
  }

  function scalarExpr(scope) {
    const c = colRef(scope);
    const r = rand();
    if (c.type === 'num') {
      if (r < 0.15) return `${c.sql} ${pick(['+', '-', '*'])} ${int(1, 60)}`;
      if (r < 0.25) return `ROUND(${c.sql} ${pick(['-', '*'])} ${pick(['0.5', '50', '1.5', '0.25'])}, ${int(0, 2)})`;
      if (r < 0.32) return `ABS(${c.sql} - ${int(1, 100)})`;
      if (r < 0.4) return `COALESCE(${c.sql}, ${int(-1, 9)})`;
      return c.sql;
    }
    if (r < 0.1) return `UPPER(${c.sql})`;
    if (r < 0.2) return `LENGTH(${c.sql})`;
    if (r < 0.3) return `COALESCE(${c.sql}, 'n/a')`;
    return c.sql;
  }

  function aggregate(scope) {
    const fn = pick(['COUNT(*)', 'COUNT', 'COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX', 'ROUND_AVG']);
    if (fn === 'COUNT(*)') return 'COUNT(*)';
    if (fn === 'COUNT') return `COUNT(${colRef(scope).sql})`;
    if (fn === 'COUNT_DISTINCT') return `COUNT(DISTINCT ${colRef(scope).sql})`;
    if (fn === 'MIN' || fn === 'MAX') return `${fn}(${colRef(scope).sql})`;
    if (fn === 'ROUND_AVG') return `ROUND(AVG(${colRef(scope, 'num').sql}), ${int(0, 2)})`;
    return `${fn}(${colRef(scope, 'num').sql})`;
  }

  function numericAggregate(scope) {
    const fn = pick(['COUNT(*)', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
    if (fn === 'COUNT(*)') return fn;
    if (fn === 'COUNT') return `COUNT(${colRef(scope).sql})`;
    return `${fn}(${colRef(scope, 'num').sql})`;
  }

  return function query() {
    aliasCounter = 0;
    const from = fromClause();
    const where = chance(0.75) ? ' WHERE ' + predicate(from.scope) : '';
    if (chance(0.35)) {
      // aggregate query
      const groupCols = [];
      if (chance(0.8)) for (let k = int(1, 2); k > 0; k--) groupCols.push(colRef(from.scope).sql);
      const uniq = [...new Set(groupCols)];
      const sel = [...uniq];
      for (let k = int(1, 3); k > 0; k--) sel.push(aggregate(from.scope));
      let sql = `SELECT ${sel.join(', ')} FROM ${from.sql}${where}`;
      if (uniq.length) sql += ` GROUP BY ${uniq.join(', ')}`;
      // HAVING compares a numeric aggregate with a number (never MIN/MAX of a text column).
      if (chance(0.3)) sql += ` HAVING ${numericAggregate(from.scope)} ${pick(['>', '<', '>=', '<>'])} ${int(0, 200)}`;
      const ob = chance(0.4) ? orderBy(sel.length) : null;
      return { sql: sql + (ob ? ob.sql : ''), ordered: !!ob, keys: ob ? ob.keys : undefined };
    }
    const sel = [];
    for (let k = int(1, 4); k > 0; k--) sel.push(scalarExpr(from.scope));
    const distinct = chance(0.2) ? 'DISTINCT ' : '';
    const ob = chance(0.5) ? orderBy(sel.length) : null;
    const sql = `SELECT ${distinct}${sel.join(', ')} FROM ${from.sql}${where}${ob ? ob.sql : ''}`;
    return { sql, ordered: !!ob, keys: ob ? ob.keys : undefined };
  };
}

test(`fuzz: ${ROUNDS} random queries vs SQLite (seed ${SEED})`, async () => {
  const gen = makeGen(prng(SEED));
  const failures = [];
  let rowsSeen = 0, nonEmpty = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const q = gen();
    const r = await runBoth(q.sql);
    let problem;
    if (r.engineError && r.sqliteError) problem = null;              // both reject: not a mismatch
    else if (r.sqliteError) problem = 'SQLite error: ' + r.sqliteError.message;
    else if (r.engineError) problem = 'dbsql error: ' + r.engineError.message;
    else {
      problem = diffResults(r.engine, r.sqlite, q);
      rowsSeen += r.sqlite.rows.length;
      if (r.sqlite.rows.length) nonEmpty++;
    }
    if (problem) failures.push({ i, sql: q.sql, problem, engine: r.engine?.rows, sqlite: r.sqlite?.rows });
  }
  console.log(`fuzz: ${ROUNDS} queries, ${nonEmpty} with non-empty results, ${rowsSeen} rows compared, ` +
    `${failures.length} mismatches`);
  for (const f of failures.slice(0, Number(process.env.FUZZ_SHOW || 8))) {
    console.log(`\n#${f.i} ${f.sql}\n  ${f.problem}\n  dbsql : ${JSON.stringify(f.engine)?.slice(0, 300)}\n  sqlite: ${JSON.stringify(f.sqlite)?.slice(0, 300)}`);
  }
  assert.equal(failures.length, 0, `${failures.length} of ${ROUNDS} queries differ from SQLite`);
});
