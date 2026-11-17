# sql-engine

A small SQL `SELECT` interpreter written in plain JavaScript, with no runtime dependencies,
tested against real SQLite.

- **Engine:** one ES module ([`src/dbsql.js`](src/dbsql.js)), about 37 KB (11.5 KB gzipped),
  that runs in any modern browser or in Node.js.
- **Correctness:** checked by *differential testing*. The same query runs on this engine and on
  SQLite (through [sql.js](https://github.com/sql-js/sql.js)), and the results must match, both
  for a hand-written suite and for thousands of randomly generated queries.
- **Strict mode:** reports mistakes that SQLite silently accepts, such as `WHERE x = NULL`.
- **Playground:** [`demo/index.html`](demo/index.html) lets you type SQL against a sample shop
  database. It works on GitHub Pages.

The repository also contains [`python/nf_engine.py`](python/nf_engine.py), a small
functional-dependency toolkit (candidate keys and 2NF / 3NF / BCNF checks). See
[Normalization toolkit](#normalization-toolkit-python).

## Quick start

```js
import { createDatabase } from './src/dbsql.js';

const db = createDatabase({
  products: { columns: ['id', 'name', 'price'], rows: [[1, 'Pen', 1.5], [2, 'Lamp', 39.9]] },
});

db.run('SELECT name FROM products WHERE price > 10');
// -> { columns: ['name'], rows: [['Lamp']], warnings: [] }
```

Errors are thrown as `SQLError` with a `message`, a `hint` and a machine-readable `code`
(`SYNTAX`, `NAME`, `SEMANTIC`, `GROUP_BY`, `TYPE`, `RUNTIME`, `UNSUPPORTED`,
`STRICT_NULL_COMPARISON`):

```js
db.run('SELECT name FROM products WHERE price = NULL');
// SQLError: Comparing with NULL using = is always UNKNOWN, so it never matches
//   hint: Use IS NULL / IS NOT NULL instead      code: STRICT_NULL_COMPARISON

db.run('SELECT name FROM products WHERE price = NULL', { strict: false });
// -> { columns: ['name'], rows: [], warnings: [{ code: 'STRICT_NULL_COMPARISON', message: '...' }] }
```

`parse(sql)` (returns the AST) and `tokenize(sql)` are exported as well.

## Supported SQL

| Area | Supported |
|---|---|
| Statement | `SELECT [DISTINCT \| ALL]`, read-only queries only |
| Select list | `*`, `t.*`, expressions, aliases (with or without `AS`) |
| FROM | tables with aliases, comma (cross) joins, `[INNER] JOIN`, `LEFT / RIGHT / FULL [OUTER] JOIN ... ON`, self joins |
| Predicates | `= <> != < > <= >=`, `AND / OR / NOT`, `[NOT] BETWEEN`, `[NOT] IN (list)`, `[NOT] IN (subquery)`, `[NOT] LIKE` with `%` and `_`, `IS [NOT] NULL`, `[NOT] EXISTS` |
| Subqueries | scalar, `IN` and `EXISTS`; correlated or not; nested |
| Grouping | `GROUP BY` expressions, `HAVING`, `COUNT(*)`, `COUNT / SUM / AVG / MIN / MAX / STDDEV / VARIANCE`, each with optional `DISTINCT` |
| Ordering | `ORDER BY` column, alias, position or expression; `ASC / DESC`; `NULLS FIRST / LAST` |
| Expressions | `+ - * /`, unary `-`, `\|\|`, `UPPER`, `LOWER`, `LENGTH`, `ROUND`, `ABS`, `CONCAT`, `COALESCE`, `NVL` |
| Lexical | `--` and `/* */` comments, `'it''s'` escapes, `"quoted identifiers"`, numbers like `1.5`, `.5`, `1e3` |
| Logic | full three-valued (`TRUE / FALSE / UNKNOWN`) NULL semantics |

### Not supported (yet)

- `UNION / INTERSECT / EXCEPT`, `LIMIT / OFFSET / FETCH`: rejected with an `UNSUPPORTED` error
- `SELECT` without `FROM` (e.g. `SELECT 1`): every query needs a `FROM` clause
- `CASE`, `CAST`, `WITH` (CTEs), window functions, `ANY / ALL / SOME`, row values such as `(a, b) IN (...)`
- `NATURAL JOIN` and `JOIN ... USING`. Every join needs an `ON` clause.
- `LIKE ... ESCAPE`; date and time types and functions
- `HAVING` that refers to a `SELECT` alias, and aggregates that appear only in `ORDER BY`
- `INSERT / UPDATE / DELETE / CREATE` and other statements that change data or schema. The database is a read-only, in-memory object.
- Indexes or a query planner. Joins are nested loops (O(n·m)), so the engine is built for
  teaching-sized data, not large tables.

## Dialect: intentional differences from SQLite

The engine follows standard SQL, and Oracle where the standard leaves a choice. Each row below
is pinned down by a test in [`tests/dialect.test.js`](tests/dialect.test.js), which also checks
that SQLite really does behave differently.

| Query | sql-engine | SQLite |
|---|---|---|
| `WHERE x = NULL` | error in strict mode; warning otherwise | no rows, no message |
| `SELECT a, b ... GROUP BY a` | error: `b` must be grouped or aggregated | value taken from an arbitrary row |
| `SELECT * ... GROUP BY a` | error | allowed |
| scalar subquery returns 2+ rows | error | uses the first row |
| `7 / 2` | `3.5` | `3` (integer division) |
| `'a' \|\| NULL` | `'a'` (Oracle) | `NULL` |
| `ORDER BY x` with NULLs | NULLs sort as the largest value: last on `ASC`, first on `DESC` (Oracle, PostgreSQL) | NULLs sort as the smallest value |
| `order_date > 73` (text vs number) | `TYPE` error; numeric text such as `'42'` is converted | compares as text, silently |
| `SELECT price > 100` | `true / false` | `1 / 0` |

## Architecture

```
SQL text ──tokenize()──▶ tokens ──Parser──▶ AST ──runQuery()──▶ { columns, rows, warnings }
```

1. **Tokenizer:** a hand-written scanner for strings, quoted identifiers, numbers, keywords,
   operators and comments. It normalises typographic quotes typed on phone keyboards, so
   pasted queries still work.
2. **Parser:** recursive descent with one function per precedence level
   (`OR` → `AND` → `NOT` → comparison/`BETWEEN`/`IN`/`LIKE`/`IS` → `+ - ||` → `* /` → unary → primary).
   It catches clauses written out of order, such as `WHERE` after `GROUP BY`, and joins with
   no `ON`, and reports each as a clear error.
3. **Evaluator:** runs the clauses in SQL's logical order:
   `FROM/JOIN → WHERE → GROUP BY → HAVING → SELECT → DISTINCT → ORDER BY`.
   - Each row is evaluated inside a context (`Ctx`) that links to the enclosing query's context.
     That is how correlated subqueries resolve outer columns, with inner names shadowing outer ones.
   - Predicates return `true`, `false` or `null` (UNKNOWN). Filters keep only `true`.
     `AND` / `OR` short-circuit the way the three-valued truth tables require.
   - Outer joins track which right-hand rows were matched, and NULL-extend the rest.
   - `GROUP BY` buckets rows by a serialised key, so NULLs form a single group, as SQL requires.
   - `SUM` / `AVG` use Kahan–Babuška–Neumaier compensated summation, the same method SQLite uses.
   - `ORDER BY` is a stable sort.

### Why not just use sql.js?

sql.js is real SQLite compiled to WebAssembly, and this project uses it as the reference in
tests. It is not the right tool for the playground, for three reasons:

- **Size:** sql.js 1.16 needs a 688 KB `.wasm` file plus 48 KB of JavaScript. This engine is
  one 37 KB file that runs offline straight from the page, with no WASM loading step.
- **Permissiveness:** SQLite accepts several queries that are almost always mistakes
  (`= NULL`, non-grouped columns, multi-row scalar subqueries). For someone learning SQL,
  an error with a hint is more useful than a silently wrong answer.
- **Readable errors:** every error carries a hint and a code, so a UI can explain what went
  wrong instead of showing a parser message.

## Testing

```bash
npm install
npm test          # unit + differential + dialect + fuzz (2,000 random queries)
npm run lint
```

| Suite | What it checks |
|---|---|
| [`tests/differential.test.js`](tests/differential.test.js) | 102 hand-written queries (joins of all kinds, grouping, correlated subqueries, `NOT IN` with NULLs, three-valued logic, ORDER BY with ties) give the same result here as in SQLite |
| [`tests/fuzz.test.js`](tests/fuzz.test.js) | Random queries from a grammar subset (joins, nested predicates, `IN` / `EXISTS` / scalar subqueries, grouping, `HAVING`, `DISTINCT`, `ORDER BY`), compared with SQLite. Uses a seeded PRNG, so any failure can be replayed |
| [`tests/dialect.test.js`](tests/dialect.test.js) | The intentional differences listed above |
| [`tests/engine.test.js`](tests/engine.test.js) | API, error codes and hints, parsing details, input validation |

How results are compared: rows are compared as multisets. When a query has `ORDER BY`, the
sequence of sort-key values must also match, but rows that tie on every sort key may come
back in any order, because SQL does not define their order. Numbers are compared to 12
significant digits.

Fuzzing with another seed or more queries:

```bash
FUZZ_SEED=7 FUZZ_ROUNDS=20000 node tests/fuzz.test.js
```

### Bugs these tests found

The engine was ported from an earlier version that had no tests. The differential and fuzz
tests found these bugs in it, all now fixed and covered by regression tests:

- `x NOT IN (empty subquery)` returned UNKNOWN when `x` was NULL; it must be TRUE.
- `ROUND` rounded `-2.5` to `-2` and `0.075` (stored as 0.07499…) to `0.08`.
- `ORDER BY ... DESC` put NULLs last instead of first.
- `AVG` / `SUM` drifted in the last bit, which moved results across `ROUND` boundaries.
- Comparing a number with text silently compared them as strings.
- `1e3` was read as `1` with the alias `e3`. `IN (SELECT a, b ...)` silently used only `a`.
- Quoted identifiers such as `"products"` crashed the engine.

## Demo

`demo/index.html` imports the engine and the sample data as ES modules, so it has to be served
over HTTP:

```bash
npm run demo      # http://localhost:8080/demo/
```

To publish it, enable **GitHub Pages** for the repository and choose *Deploy from a branch*,
`main`, `/ (root)`. The playground is then at `https://<user>.github.io/sql-engine/demo/`.

The sample database ([`data/shop.js`](data/shop.js)) is a fictional online shop with
`customers`, `suppliers`, `products`, `orders` and `order_items`. It deliberately includes NULLs
and unmatched rows, so the different join types give visibly different results.

## Normalization toolkit (Python)

[`python/nf_engine.py`](python/nf_engine.py) works from functional dependencies (FDs):

```python
from nf_engine import parse_fds, candidate_keys, highest_normal_form, is_lossless

fds = parse_fds("student, course -> instructor; instructor -> course")
rel = ["student", "course", "instructor"]
candidate_keys(rel, fds)        # [('student', 'course'), ('student', 'instructor')]
highest_normal_form(rel, fds)   # '3NF'  (instructor -> course violates BCNF)
```

It provides attribute closure, candidate keys, prime attributes, projected FDs, partial and
transitive dependencies, 2NF / 3NF / BCNF checks, and a chase-based lossless-join test.
Running time is exponential in the number of attributes, which is fine for relations of
up to about 15 attributes.

```bash
python -m pip install pytest
python -m pytest            # 12 hand-checked examples + 800 seeded random cases vs brute-force definitions
```

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request:
ESLint and the Node test suite on Node 20, 22 and 24, then Ruff and pytest on Python 3.10 and 3.12.

Built with Claude Code as a pair programmer; the design decisions and testing strategy are my own.

## License

[MIT](LICENSE)
