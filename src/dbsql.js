/**
 * dbsql — a small, dependency-free SQL SELECT interpreter.
 *
 * Pipeline: tokenize(sql) -> Parser -> AST -> evaluator (FROM/JOIN -> WHERE ->
 * GROUP BY -> HAVING -> SELECT -> DISTINCT -> ORDER BY).
 *
 * Supported: SELECT [DISTINCT] ... FROM ... [INNER|LEFT|RIGHT|FULL [OUTER] JOIN ... ON ...]
 *            [WHERE ...] [GROUP BY ...] [HAVING ...] [ORDER BY ... [ASC|DESC] [NULLS FIRST|LAST]],
 *            comma (cross) joins, self joins, scalar / IN / EXISTS subqueries (correlated or not),
 *            three-valued NULL logic.
 *
 * Usage:
 *   import { createDatabase } from './dbsql.js';
 *   const db = createDatabase({ products: { columns: ['id', 'name'], rows: [[1, 'Pen']] } });
 *   db.run('SELECT name FROM products');   // -> { columns: ['name'], rows: [['Pen']], warnings: [] }
 *
 * Errors are thrown as SQLError, which carries a `hint` and a machine-readable `code`.
 */

/* ============================== 1. Errors ============================== */

export class SQLError extends Error {
  constructor(message, { hint = '', code = 'SQL_ERROR' } = {}) {
    super(message);
    this.name = 'SQLError';
    this.hint = hint;
    this.code = code;
  }
}

function err(message, hint, code) {
  return new SQLError(message, { hint: hint || '', code: code || 'SQL_ERROR' });
}

/* ============================== 2. Tokenizer ============================== */

const KEYWORDS = new Set((
  'select distinct all from where group by having order asc desc ' +
  'inner left right full outer join on as and or not null is in between like ' +
  'exists union case when then else end limit'
).split(' '));

const IDENT_START = /[\p{L}_]/u;
const IDENT = /^[\p{L}_][\p{L}\p{N}_]*/u;

export function tokenize(src) {
  // Typographic quotes and dashes (inserted by some mobile keyboards) are normalised
  // first; otherwise a query typed on a phone can never parse.
  src = String(src)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/–|—/g, '-');
  const t = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {            // -- comment to end of line
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {            // /* block comment */
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'") {                                   // string literal; '' is an escaped quote
      let j = i + 1, s = '';
      while (j < n) {
        if (src[j] === "'" && src[j + 1] === "'") { s += "'"; j += 2; continue; }
        if (src[j] === "'") break;
        s += src[j++];
      }
      if (j >= n) {
        throw err("Unterminated string literal: a ' was opened but never closed",
          "String values go in single quotes, e.g. WHERE city = 'Lisbon'", 'SYNTAX');
      }
      t.push({ k: 'str', v: s, p: i });
      i = j + 1;
      continue;
    }
    if (c === '"') {                                   // "quoted identifier"
      const j = src.indexOf('"', i + 1);
      if (j < 0) throw err('Unterminated quoted identifier: a " was opened but never closed', '', 'SYNTAX');
      t.push({ k: 'id', v: src.slice(i + 1, j), raw: src.slice(i + 1, j), p: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      t.push({ k: 'num', v: parseFloat(m[0]), p: i });
      i += m[0].length;
      continue;
    }
    if (IDENT_START.test(c)) {
      const w = IDENT.exec(src.slice(i))[0];
      const lw = w.toLowerCase();
      t.push({ k: KEYWORDS.has(lw) ? 'kw' : 'id', v: KEYWORDS.has(lw) ? lw : w, raw: w, p: i });
      i += w.length;
      continue;
    }
    const two = src.substr(i, 2);
    if (two === '<>' || two === '!=' || two === '<=' || two === '>=' || two === '||') {
      t.push({ k: 'op', v: two === '!=' ? '<>' : two, p: i });
      i += 2;
      continue;
    }
    if ('=<>+-*/(),.;'.includes(c)) { t.push({ k: 'op', v: c, p: i }); i++; continue; }
    throw err('Unexpected character ' + JSON.stringify(c),
      'Check for a stray symbol or a character SQL does not understand', 'SYNTAX');
  }
  t.push({ k: 'eof', v: '', p: n });
  return t;
}

/* ============================== 3. Parser ============================== */

const CLAUSE_ORDER = ['select', 'from', 'where', 'group', 'having', 'order'];
const CLAUSE_TEXT = 'SELECT -> FROM -> WHERE -> GROUP BY -> HAVING -> ORDER BY';
const AGGREGATES = new Set(['MIN', 'MAX', 'SUM', 'COUNT', 'AVG', 'STDDEV', 'VARIANCE']);

function shown(tok) {
  return tok.raw || (tok.v === '' ? 'end of input' : String(tok.v));
}

class Parser {
  constructor(toks) { this.t = toks; this.i = 0; }
  peek(o) { return this.t[this.i + (o || 0)]; }
  at(kw) { const x = this.peek(); return x.k === 'kw' && x.v === kw; }
  atOp(o) { const x = this.peek(); return x.k === 'op' && x.v === o; }
  atWord(w) { const x = this.peek(); return x.k === 'id' && x.raw.toLowerCase() === w; }
  next() { return this.t[this.i++]; }
  eat(kw) { if (this.at(kw)) { this.i++; return true; } return false; }
  want(kw, why) {
    if (!this.eat(kw)) {
      throw err('Expected ' + kw.toUpperCase() + ' but found "' + shown(this.peek()) + '"', why || '', 'SYNTAX');
    }
    return true;
  }
  wantOp(o) {
    if (this.atOp(o)) { this.i++; return true; }
    throw err('Expected ' + o + ' but found "' + shown(this.peek()) + '"', '', 'SYNTAX');
  }

  /* ---------- full SELECT statement ---------- */
  query() {
    const q = { sel: [], distinct: false, from: [], where: null, group: null, having: null, order: null };
    if (!this.at('select')) {
      const f = this.peek();
      if (f.k === 'kw' && CLAUSE_ORDER.includes(f.v)) {
        throw err('A query must start with SELECT, but it starts with ' + f.v.toUpperCase(),
          'Clause order is ' + CLAUSE_TEXT, 'SYNTAX');
      }
      throw err('A query must start with SELECT', 'Clause order is ' + CLAUSE_TEXT, 'SYNTAX');
    }
    this.next();
    if (this.eat('distinct')) q.distinct = true; else this.eat('all');
    q.sel = this.selectList();

    this.guard('from');
    this.want('from', 'Every SELECT needs a FROM clause naming the table(s) to read');
    q.from = this.fromList();

    if (this.at('where')) { this.next(); q.where = this.expr(); }
    this.guard('group');
    if (this.at('group')) {
      this.next();
      this.want('by', 'GROUP is always followed by BY');
      q.group = [this.expr()];
      while (this.atOp(',')) { this.next(); q.group.push(this.expr()); }
    }
    this.guard('having');
    if (this.at('having')) { this.next(); q.having = this.expr(); }
    this.guard('order');
    if (this.at('order')) {
      this.next();
      this.want('by', 'ORDER is always followed by BY');
      q.order = [];
      do {
        const e = this.expr();
        let dir = 'asc', nulls = null;
        if (this.eat('desc')) dir = 'desc'; else this.eat('asc');
        if (this.atWord('nulls')) {
          this.next();
          if (this.atWord('first')) nulls = 'first';
          else if (this.atWord('last')) nulls = 'last';
          else throw err('Expected FIRST or LAST after NULLS but found "' + shown(this.peek()) + '"', '', 'SYNTAX');
          this.next();
        }
        q.order.push({ e, dir, nulls });
      } while (this.atOp(',') && this.next());
    }
    return q;
  }

  /* Seeing a clause that belongs earlier than the current one means clauses are out of order. */
  guard(nowClause) {
    const x = this.peek();
    if (x.k !== 'kw') return;
    const here = CLAUSE_ORDER.indexOf(nowClause), seen = CLAUSE_ORDER.indexOf(x.v);
    if (seen >= 0 && seen < here) {
      throw err(x.v.toUpperCase() + ' is out of order', 'Clause order is ' + CLAUSE_TEXT, 'SYNTAX');
    }
  }

  selectList() {
    const out = [];
    do {
      if (this.atOp('*')) { this.next(); out.push({ star: true, tbl: null }); }
      else if (this.peek().k === 'id' && this.peek(1).k === 'op' && this.peek(1).v === '.' &&
               this.peek(2).k === 'op' && this.peek(2).v === '*') {
        const tb = this.next().raw;
        this.i += 2;
        out.push({ star: true, tbl: tb });
      } else {
        const e = this.expr();
        let alias = null;
        if (this.eat('as')) { const av = this.next(); alias = av.raw || String(av.v); }
        else if (this.peek().k === 'id') alias = this.next().raw;
        out.push({ e, alias });
      }
    } while (this.atOp(',') && this.next());
    return out;
  }

  fromList() {
    const items = [this.tableRef()];
    while (this.atOp(',')) { this.next(); items.push(this.tableRef()); }
    for (;;) {
      let kind;
      if (this.at('inner')) { this.next(); kind = 'inner'; }
      else if (this.at('left')) { this.next(); this.eat('outer'); kind = 'left'; }
      else if (this.at('right')) { this.next(); this.eat('outer'); kind = 'right'; }
      else if (this.at('full')) { this.next(); this.eat('outer'); kind = 'full'; }
      else if (this.at('join')) kind = 'inner';
      else break;
      this.want('join', kind.toUpperCase() + ' must be followed by JOIN');
      const tr = this.tableRef();
      if (!this.at('on')) {
        throw err('JOIN without ON: the join condition is missing',
          'Without ON every row is paired with every row; write e.g. JOIN t2 ON t1.id = t2.t1_id', 'SYNTAX');
      }
      this.next();
      tr.join = kind;
      tr.on = this.expr();
      items.push(tr);
    }
    return items;
  }

  tableRef() {
    const x = this.peek();
    if (x.k !== 'id') throw err('Expected a table name but found "' + shown(x) + '"', '', 'SYNTAX');
    this.next();
    const name = x.raw;
    let alias = name;
    if (this.eat('as')) alias = this.next().raw;
    else if (this.peek().k === 'id') alias = this.next().raw;
    return { table: name, alias, join: null, on: null };
  }

  /* ---------- expressions (lowest to highest precedence) ---------- */
  expr() { return this.orExpr(); }
  orExpr() {
    let l = this.andExpr();
    while (this.at('or')) { this.next(); l = { t: 'bin', op: 'or', l, r: this.andExpr() }; }
    return l;
  }
  andExpr() {
    let l = this.notExpr();
    while (this.at('and')) { this.next(); l = { t: 'bin', op: 'and', l, r: this.notExpr() }; }
    return l;
  }
  notExpr() {
    if (this.at('not')) { this.next(); return { t: 'not', e: this.notExpr() }; }
    return this.cmpExpr();
  }
  cmpExpr() {
    let l = this.addExpr();
    for (;;) {
      let neg = false;
      if (this.at('not') && this.peek(1).k === 'kw' && ['between', 'in', 'like'].includes(this.peek(1).v)) {
        this.next();
        neg = true;
      }
      if (this.at('between')) {
        this.next();
        const lo = this.addExpr();
        this.want('and', 'BETWEEN needs AND, e.g. BETWEEN 10 AND 20');
        l = { t: 'between', e: l, lo, hi: this.addExpr(), neg };
        continue;
      }
      if (this.at('in')) {
        this.next();
        this.wantOp('(');
        let node;
        if (this.at('select')) node = { t: 'in', e: l, sub: this.query(), neg };
        else {
          const list = [this.expr()];
          while (this.atOp(',')) { this.next(); list.push(this.expr()); }
          node = { t: 'in', e: l, list, neg };
        }
        this.wantOp(')');
        l = node;
        continue;
      }
      if (this.at('like')) {
        this.next();
        l = { t: 'like', e: l, pat: this.addExpr(), neg };
        continue;
      }
      if (this.at('is')) {
        this.next();
        const nneg = this.eat('not');
        this.want('null', 'IS can only be followed by NULL or NOT NULL');
        l = { t: 'isnull', e: l, neg: nneg };
        continue;
      }
      if (neg) throw err('NOT must be followed by BETWEEN, IN or LIKE here', '', 'SYNTAX');
      const x = this.peek();
      if (x.k === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(x.v)) {
        this.next();
        l = { t: 'bin', op: x.v, l, r: this.addExpr() };
        continue;
      }
      return l;
    }
  }
  addExpr() {
    let l = this.mulExpr();
    for (;;) {
      const x = this.peek();
      if (x.k === 'op' && (x.v === '+' || x.v === '-' || x.v === '||')) {
        this.next();
        l = { t: 'bin', op: x.v, l, r: this.mulExpr() };
      } else return l;
    }
  }
  mulExpr() {
    let l = this.unary();
    for (;;) {
      const x = this.peek();
      if (x.k === 'op' && (x.v === '*' || x.v === '/')) {
        this.next();
        l = { t: 'bin', op: x.v, l, r: this.unary() };
      } else return l;
    }
  }
  unary() {
    if (this.atOp('-')) { this.next(); return { t: 'neg', e: this.unary() }; }
    if (this.atOp('+')) { this.next(); return this.unary(); }
    return this.primary();
  }
  primary() {
    const x = this.peek();
    if (x.k === 'num') { this.next(); return { t: 'lit', v: x.v }; }
    if (x.k === 'str') { this.next(); return { t: 'lit', v: x.v }; }
    if (x.k === 'kw' && x.v === 'null') { this.next(); return { t: 'lit', v: null }; }
    if (x.k === 'kw' && x.v === 'exists') {
      this.next();
      this.wantOp('(');
      const q = this.query();
      this.wantOp(')');
      return { t: 'exists', sub: q, neg: false };
    }
    if (x.k === 'op' && x.v === '(') {
      this.next();
      if (this.at('select')) { const sq = this.query(); this.wantOp(')'); return { t: 'sub', sub: sq }; }
      const e = this.expr();
      this.wantOp(')');
      return e;
    }
    if (x.k === 'id') {
      const name = this.next().raw;
      if (this.atOp('(')) return this.callExpr(name);
      if (this.atOp('.')) {
        this.next();
        if (this.atOp('*')) { this.next(); return { t: 'col', tbl: name, name: '*' }; }
        const c = this.next();
        if (c.k !== 'id') throw err('Expected a column name after "."', '', 'SYNTAX');
        return { t: 'col', tbl: name, name: c.raw };
      }
      return { t: 'col', tbl: null, name };
    }
    throw err('Could not parse the query near "' + shown(x) + '"',
      'Look for a missing comma, parenthesis or keyword', 'SYNTAX');
  }
  callExpr(name) {
    const fn = name.toUpperCase();
    this.wantOp('(');
    if (AGGREGATES.has(fn)) {
      const dist = this.eat('distinct');
      let star = false, arg = null;
      if (this.atOp('*')) { this.next(); star = true; } else arg = this.expr();
      this.wantOp(')');
      if (star && fn !== 'COUNT') {
        throw err(fn + '(*) is not valid: only COUNT accepts *', 'Write ' + fn + '(column) instead', 'SYNTAX');
      }
      return { t: 'agg', fn, arg, star, distinct: dist };
    }
    const args = [];
    if (!this.atOp(')')) {
      args.push(this.expr());
      while (this.atOp(',')) { this.next(); args.push(this.expr()); }
    }
    this.wantOp(')');
    return { t: 'call', fn, args };
  }
}

/** Parse one SELECT statement into an AST. */
export function parse(sql) {
  const toks = tokenize(sql);
  if (toks.length <= 1) throw err('The query is empty', '', 'SYNTAX');
  const p = new Parser(toks);
  const q = p.query();
  while (p.atOp(';')) p.next();
  if (p.peek().k !== 'eof') {
    const x = p.peek();
    if (x.k === 'kw' && x.v === 'union') throw err('UNION is not supported', 'Run each SELECT separately', 'UNSUPPORTED');
    if (x.k === 'kw' && x.v === 'limit') throw err('LIMIT is not supported', '', 'UNSUPPORTED');
    throw err('Unexpected input after the end of the query: "' + shown(x) + '"',
      'Is a comma missing between columns, or are two statements run together?', 'SYNTAX');
  }
  return q;
}

/* ============================== 4. Evaluator ============================== */

function isNull(v) { return v === null || v === undefined; }
function num(v) {
  if (isNull(v)) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isNaN(n) ? null : n;
}
function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
function truthy(v) { return v === true; }          // NULL (unknown) never passes a filter

/*
 * Comparison used by predicates (=, <>, <, >, <=, >=, BETWEEN, IN). A number compared with
 * text converts the text when it is a plain numeric literal ('42'), like Oracle's implicit
 * conversion; anything else ('2025-01-05' < 73) is a type error instead of a silent string
 * comparison.
 */
const NUMERIC_TEXT = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)\s*$/;
function asNumber(text, other) {
  if (!NUMERIC_TEXT.test(text)) {
    throw err('Cannot compare text ' + JSON.stringify(text) + ' with the number ' + other,
      'Compare values of the same type, e.g. a date column with a quoted date', 'TYPE');
  }
  return parseFloat(text);
}
function cmpValues(a, b) {
  if (typeof a === 'number' && typeof b === 'string') return cmp(a, asNumber(b, a));
  if (typeof a === 'string' && typeof b === 'number') return cmp(asNumber(a, b), b);
  return cmp(a, b);
}

/* Kahan-Babuska-Neumaier summation: the same compensated sum SQLite (3.43+) uses for SUM/AVG. */
function preciseSum(xs) {
  let s = 0, c = 0;
  for (const x of xs) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s;
    s = t;
  }
  return s + c;
}

/* Does the expression contain an aggregate (outside of nested subqueries)? */
function hasAgg(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.t === 'agg') return true;
  if (e.t === 'sub' || e.t === 'exists') return false;
  for (const k in e) {
    const v = e[k];
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) { for (const x of v) if (hasAgg(x)) return true; }
      else if (hasAgg(v)) return true;
    }
  }
  return false;
}
function exprKey(e) { return JSON.stringify(e); }

/* Evaluation context for one row: row = {alias: {column: value}}, outer = enclosing query's context. */
class Ctx {
  constructor(cols, row, outer, env) { this.cols = cols; this.row = row; this.outer = outer; this.env = env; }

  lookup(tbl, name) {
    const r = this.row;
    if (tbl) {
      let key = null;
      for (const a in r) if (a.toLowerCase() === tbl.toLowerCase()) key = a;
      if (key === null) {
        if (this.outer) return this.outer.lookup(tbl, name);
        throw err('Unknown table or alias "' + tbl + '"',
          'Declare the alias in FROM first, e.g. FROM orders o, then write o.' + name, 'NAME');
      }
      const t = r[key];
      const cn = findCol(this.cols[key], name);
      if (!cn) {
        throw err('Table ' + key + ' has no column "' + name + '"',
          'Its columns are: ' + this.cols[key].join(', '), 'NAME');
      }
      return t ? t[cn] : null;
    }
    const found = [];
    for (const a in r) if (findCol(this.cols[a], name)) found.push(a);
    if (found.length === 1) {
      const cn = findCol(this.cols[found[0]], name);
      return r[found[0]] ? r[found[0]][cn] : null;
    }
    if (found.length > 1) {
      throw err('Column "' + name + '" is ambiguous: it exists in ' + found.join(', '),
        'Qualify it with a table alias, e.g. ' + found[0] + '.' + name, 'NAME');
    }
    if (this.outer) return this.outer.lookup(tbl, name);
    throw err('Unknown column "' + name + '"',
      'Check the spelling (case does not matter) and that its table is in FROM', 'NAME');
  }
}

function findCol(cols, name) {
  if (!cols) return null;
  const lname = String(name).toLowerCase();
  for (const c of cols) if (c.toLowerCase() === lname) return c;
  return null;
}

function likeToRe(pat) {
  let out = '^';
  for (const c of pat) {
    if (c === '%') out += '[\\s\\S]*';
    else if (c === '_') out += '[\\s\\S]';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$', 'i');
}

function singleColumn(result, what) {
  if (result.cols.length !== 1) {
    throw err(what + ' subquery must return exactly one column, but it returns ' + result.cols.length,
      'Select a single column inside the subquery', 'SEMANTIC');
  }
  return result;
}

function warn(env, code, message) {
  if (!env.warnings.some((w) => w.code === code && w.message === message)) env.warnings.push({ code, message });
}

/* Evaluate an expression. `group` is the list of rows of the current group (aggregate mode) or null. */
function ev(e, ctx, group) {
  switch (e.t) {
    case 'lit': return e.v;
    case 'col': return ctx.lookup(e.tbl, e.name);
    case 'neg': { const v = num(ev(e.e, ctx, group)); return isNull(v) ? null : -v; }
    case 'not': { const b = ev(e.e, ctx, group); return isNull(b) ? null : !b; }
    case 'bin': return evBin(e, ctx, group);
    case 'between': {
      const x = ev(e.e, ctx, group), lo = ev(e.lo, ctx, group), hi = ev(e.hi, ctx, group);
      if (isNull(x) || isNull(lo) || isNull(hi)) return null;
      const r = cmpValues(x, lo) >= 0 && cmpValues(x, hi) <= 0;
      return e.neg ? !r : r;
    }
    case 'like': {
      const s = ev(e.e, ctx, group), p = ev(e.pat, ctx, group);
      if (isNull(s) || isNull(p)) return null;
      const r = likeToRe(String(p)).test(String(s));
      return e.neg ? !r : r;
    }
    case 'isnull': { const v = ev(e.e, ctx, group); return e.neg ? !isNull(v) : isNull(v); }
    case 'in': {
      const x = ev(e.e, ctx, group);
      const vals = e.sub ? singleColumn(runQuery(e.sub, ctx, ctx.env), 'IN').rows.map((r) => r[0])
                         : e.list.map((n) => ev(n, ctx, group));
      // x IN (empty set) is FALSE (and NOT IN is TRUE) even when x is NULL: there is
      // nothing to compare with, so the result is not UNKNOWN.
      if (vals.length === 0) return !!e.neg;
      if (isNull(x)) return null;
      let anyNull = false, hit = false;
      for (const v of vals) { if (isNull(v)) anyNull = true; else if (cmpValues(x, v) === 0) hit = true; }
      if (hit) return !e.neg;
      if (anyNull) return null;
      return e.neg;
    }
    case 'exists': {
      const res = runQuery(e.sub, ctx, ctx.env);
      return e.neg ? res.rows.length === 0 : res.rows.length > 0;
    }
    case 'sub': {
      const r = singleColumn(runQuery(e.sub, ctx, ctx.env), 'A scalar');
      if (r.rows.length === 0) return null;
      if (r.rows.length > 1) {
        throw err('Scalar subquery returned more than one row',
          'Make the subquery return a single row, or use IN (...) instead of =', 'RUNTIME');
      }
      return r.rows[0][0];
    }
    case 'call': return evCall(e, ctx, group);
    case 'agg': return evAgg(e, ctx, group);
  }
  throw err('Cannot evaluate expression', '', 'RUNTIME');
}

function evBin(e, ctx, group) {
  const op = e.op;
  if (op === 'and') {
    const a = ev(e.l, ctx, group);
    if (a === false) return false;
    const b = ev(e.r, ctx, group);
    if (b === false) return false;
    if (isNull(a) || isNull(b)) return null;
    return true;
  }
  if (op === 'or') {
    const a = ev(e.l, ctx, group);
    if (a === true) return true;
    const b = ev(e.r, ctx, group);
    if (b === true) return true;
    if (isNull(a) || isNull(b)) return null;
    return false;
  }
  // `x = NULL` / `x <> NULL` is never true: the comparison is UNKNOWN for every row.
  if ((op === '=' || op === '<>') &&
      ((e.r.t === 'lit' && e.r.v === null) || (e.l.t === 'lit' && e.l.v === null))) {
    const msg = 'Comparing with NULL using ' + op + ' is always UNKNOWN, so it never matches';
    const hint = 'Use IS NULL / IS NOT NULL instead';
    if (ctx.env.strict) throw err(msg, hint, 'STRICT_NULL_COMPARISON');
    warn(ctx.env, 'STRICT_NULL_COMPARISON', msg + '. ' + hint);
  }
  const l = ev(e.l, ctx, group), r = ev(e.r, ctx, group);
  if (op === '||') {
    if (isNull(l) && isNull(r)) return null;
    return (isNull(l) ? '' : l) + '' + (isNull(r) ? '' : r);
  }
  if (isNull(l) || isNull(r)) return null;
  switch (op) {
    case '+': return num(l) + num(r);
    case '-': return num(l) - num(r);
    case '*': return num(l) * num(r);
    case '/': return num(r) === 0 ? null : num(l) / num(r);
    case '=': return cmpValues(l, r) === 0;
    case '<>': return cmpValues(l, r) !== 0;
    case '<': return cmpValues(l, r) < 0;
    case '>': return cmpValues(l, r) > 0;
    case '<=': return cmpValues(l, r) <= 0;
    case '>=': return cmpValues(l, r) >= 0;
  }
  throw err('Unknown operator ' + op, '', 'RUNTIME');
}

const SCALAR_FUNCTIONS = 'UPPER LOWER LENGTH ROUND ABS CONCAT NVL COALESCE';

/**
 * ROUND(x, d): round half away from zero, based on the exact binary value of x.
 * `Math.round(x * 10^d) / 10^d` is wrong twice: Math.round rounds -2.5 to -2, and the
 * multiplication can turn 0.07499999... (the double nearest 0.075) into exactly 7.5.
 * toFixed() rounds the exact value instead. d = 0 mirrors SQLite's (x +/- 0.5) truncation.
 */
function round(x, d) {
  if (isNull(x)) return null;
  const digits = isNull(d) ? 0 : Math.min(100, Math.max(0, Math.trunc(d)));
  if (!isFinite(x)) return x;
  if (digits === 0) {
    if (Math.abs(x) >= 4503599627370496) return x;            // 2^52: already an integer
    return Math.trunc(x + (x < 0 ? -0.5 : 0.5));
  }
  const r = Number(Math.abs(x).toFixed(digits));
  return x < 0 ? -r : r;
}

function evCall(e, ctx, group) {
  const a = e.args.map((x) => ev(x, ctx, group));
  switch (e.fn) {
    case 'UPPER': return isNull(a[0]) ? null : String(a[0]).toUpperCase();
    case 'LOWER': return isNull(a[0]) ? null : String(a[0]).toLowerCase();
    case 'LENGTH': return isNull(a[0]) ? null : String(a[0]).length;
    case 'ROUND': return round(num(a[0]), a.length > 1 ? num(a[1]) : 0);
    case 'ABS': return isNull(a[0]) ? null : Math.abs(num(a[0]));
    case 'CONCAT': return a.every(isNull) ? null : a.map((v) => (isNull(v) ? '' : v)).join('');
    case 'NVL': case 'COALESCE': {
      for (const v of a) if (!isNull(v)) return v;
      return null;
    }
  }
  throw err('Unknown function ' + e.fn + '()',
    'Available: ' + [...AGGREGATES].join(' ') + ' | ' + SCALAR_FUNCTIONS, 'NAME');
}

function evAgg(e, ctx, group) {
  if (!group) {
    throw err(e.fn + '() cannot be used here',
      'WHERE runs before GROUP BY, so there is no group to aggregate yet; move the condition to HAVING', 'SEMANTIC');
  }
  let vals = [], n = 0;
  for (const row of group) {
    const c = new Ctx(ctx.cols, row, ctx.outer, ctx.env);
    if (e.star) { n++; continue; }
    const v = ev(e.arg, c, null);
    if (!isNull(v)) vals.push(v);           // aggregates skip NULLs
  }
  if (e.distinct) {
    const seen = new Set(), u = [];
    for (const v of vals) { const k = typeof v + ':' + v; if (!seen.has(k)) { seen.add(k); u.push(v); } }
    vals = u;
  }
  if (e.fn === 'COUNT') return e.star ? n : vals.length;
  if (vals.length === 0) return null;      // no values -> NULL (COUNT returns 0 instead)
  const nums = vals.map(num);
  const sum = () => preciseSum(nums);
  switch (e.fn) {
    case 'SUM': return sum();
    case 'AVG': return sum() / nums.length;
    case 'MIN': return vals.reduce((x, y) => (cmp(x, y) <= 0 ? x : y));
    case 'MAX': return vals.reduce((x, y) => (cmp(x, y) >= 0 ? x : y));
    case 'VARIANCE': case 'STDDEV': {
      if (nums.length < 2) return e.fn === 'STDDEV' ? 0 : null;
      const m = sum() / nums.length;
      const s2 = nums.reduce((acc, y) => acc + (y - m) * (y - m), 0) / (nums.length - 1);
      return e.fn === 'STDDEV' ? Math.sqrt(s2) : s2;
    }
  }
  throw err('Unknown aggregate ' + e.fn, '', 'NAME');
}

/* ---------- FROM / JOIN ---------- */
function buildRows(q, outerCtx, env) {
  const cols = {};
  let rows = [{}];
  for (const it of q.from) {
    let def = null;
    for (const t in env.tables) if (t.toLowerCase() === it.table.toLowerCase()) def = env.tables[t];
    if (!def) {
      throw err('No table named "' + it.table + '"',
        'Available tables: ' + Object.keys(env.tables).join(', '), 'NAME');
    }
    if (cols[it.alias]) {
      throw err('Alias "' + it.alias + '" is used twice',
        'A self join needs two different aliases, e.g. FROM t a JOIN t b ON a.parent_id = b.id', 'NAME');
    }
    cols[it.alias] = def.columns;
    const right = def.rows.map((r) => {
      const o = {};
      def.columns.forEach((c, i) => { o[c] = r[i]; });
      return o;
    });
    rows = joinRows(rows, right, it, cols, outerCtx, env);
  }
  return { cols, rows };
}

function joinRows(left, right, it, cols, outerCtx, env) {
  const out = [], kind = it.join || 'cross';
  const matchedRight = right.map(() => false);
  for (const lr of left) {
    let any = false;
    right.forEach((rr, ri) => {
      const merged = { ...lr, [it.alias]: rr };
      if (kind === 'cross') { out.push(merged); any = true; matchedRight[ri] = true; return; }
      if (truthy(ev(it.on, new Ctx(cols, merged, outerCtx, env), null))) {
        out.push(merged);
        any = true;
        matchedRight[ri] = true;
      }
    });
    if (!any && (kind === 'left' || kind === 'full')) {
      out.push({ ...lr, [it.alias]: null });          // no match on the right -> NULL-extended
    }
  }
  if (kind === 'right' || kind === 'full') {
    right.forEach((rr, ri) => {
      if (matchedRight[ri]) return;
      const m = {};
      for (const a in cols) if (a !== it.alias) m[a] = null;   // no match on the left -> NULL-extended
      m[it.alias] = rr;
      out.push(m);
    });
  }
  return out;
}

/* ---------- run a query in logical processing order ---------- */
function runQuery(q, outerCtx, env) {
  /* 1. FROM + JOIN */
  const built = buildRows(q, outerCtx, env);
  const cols = built.cols;
  let rows = built.rows;

  /* 2. WHERE (no group yet, so aggregates here raise an error) */
  if (q.where) rows = rows.filter((r) => truthy(ev(q.where, new Ctx(cols, r, outerCtx, env), null)));

  /* 3. GROUP BY */
  const grouping = !!q.group || q.sel.some((s) => s.e && hasAgg(s.e)) || (q.having && hasAgg(q.having));
  let groups;
  if (!grouping) {
    groups = rows.map((r) => ({ key: null, rows: [r], head: r }));
  } else if (!q.group) {
    groups = [{ key: null, rows, head: rows[0] || {} }];      // the whole input is one group
  } else {
    const map = new Map();
    for (const r of rows) {
      const ctx = new Ctx(cols, r, outerCtx, env);
      const kv = q.group.map((g) => ev(g, ctx, null));
      const k = JSON.stringify(kv);
      if (!map.has(k)) map.set(k, { key: kv, rows: [], head: r });
      map.get(k).rows.push(r);
    }
    groups = [...map.values()];
  }

  /* 3.5 Every non-aggregated SELECT column must appear in GROUP BY */
  if (grouping && q.group) {
    const gkeys = new Set();
    for (const g of q.group) {
      gkeys.add(exprKey(g));
      if (g.t === 'col') gkeys.add('col:' + g.name.toLowerCase());
    }
    for (const s of q.sel) {
      if (s.star) {
        throw err('SELECT * cannot be combined with GROUP BY',
          'List the columns explicitly; every non-aggregated column must be in GROUP BY', 'GROUP_BY');
      }
      checkGrouped(s.e, gkeys);
    }
    if (q.order) for (const o of q.order) checkGroupedOrder(o.e, gkeys, q);
  }

  /* 4. HAVING */
  if (q.having) {
    if (!grouping) {
      throw err('HAVING without GROUP BY or an aggregate', 'Use WHERE for conditions on individual rows', 'SEMANTIC');
    }
    groups = groups.filter((g) => truthy(ev(q.having, new Ctx(cols, g.head, outerCtx, env), g.rows)));
  }

  /* 5. SELECT */
  const plan = [];
  for (const s of q.sel) {
    if (s.star) {
      for (const a in cols) {
        if (s.tbl && a.toLowerCase() !== s.tbl.toLowerCase()) continue;
        for (const c of cols[a]) plan.push({ name: c, e: { t: 'col', tbl: a, name: c } });
      }
      if (plan.length === 0) throw err('Unknown table "' + s.tbl + '" in ' + s.tbl + '.*', '', 'NAME');
    } else {
      plan.push({ name: s.alias || headerOf(s.e), e: s.e });
    }
  }
  const outCols = plan.map((p) => p.name);
  let outRows = groups.map((g) => {
    const ctx = new Ctx(cols, g.head, outerCtx, env);
    return plan.map((p) => ev(p.e, ctx, grouping ? g.rows : null));
  });

  /* 6. DISTINCT */
  if (q.distinct) {
    const seen = new Set(), uniq = [];
    for (const r of outRows) {
      const k = JSON.stringify(r);
      if (!seen.has(k)) { seen.add(k); uniq.push(r); }
    }
    outRows = uniq;
  }

  /* 7. ORDER BY: output column name, alias, ordinal position, or any expression */
  if (q.order) {
    const keyed = outRows.map((r, i) => ({ r, i, g: q.distinct ? null : groups[i] }));
    const specs = q.order.map((o) => {
      let idx;
      if (o.e.t === 'lit' && typeof o.e.v === 'number') idx = o.e.v - 1;
      else if (o.e.t === 'col' && !o.e.tbl) {
        idx = outCols.findIndex((c) => String(c).toLowerCase() === o.e.name.toLowerCase());
      } else {
        const ek = exprKey(o.e);
        idx = plan.findIndex((p) => exprKey(p.e) === ek);
      }
      if (idx >= 0 && idx >= outCols.length) {
        throw err('ORDER BY position ' + (idx + 1) + ' is out of range: the result has ' +
          outCols.length + ' column(s)', '', 'SEMANTIC');
      }
      // NULL sorts as the largest value (Oracle / PostgreSQL): last on ASC, first on DESC.
      return { idx, e: o.e, dir: o.dir, nulls: o.nulls || (o.dir === 'desc' ? 'first' : 'last') };
    });
    keyed.sort((A, B) => {
      for (const sp of specs) {
        let a, b;
        if (sp.idx >= 0) { a = A.r[sp.idx]; b = B.r[sp.idx]; }
        else {
          const ga = A.g, gb = B.g;
          if (!ga || !gb) {
            throw err('With DISTINCT, ORDER BY expressions must appear in the SELECT list',
              'Add the expression to SELECT', 'SEMANTIC');
          }
          a = ev(sp.e, new Ctx(cols, ga.head, outerCtx, env), grouping ? ga.rows : null);
          b = ev(sp.e, new Ctx(cols, gb.head, outerCtx, env), grouping ? gb.rows : null);
        }
        let c;
        if (isNull(a) && isNull(b)) c = 0;
        else if (isNull(a)) c = sp.nulls === 'first' ? -1 : 1;
        else if (isNull(b)) c = sp.nulls === 'first' ? 1 : -1;
        else c = sp.dir === 'desc' ? -cmp(a, b) : cmp(a, b);
        if (c) return c;
      }
      return A.i - B.i;                       // stable: ties keep their input order
    });
    outRows = keyed.map((x) => x.r);
  }
  return { cols: outCols, rows: outRows };
}

function checkGrouped(e, gkeys) {
  if (!e || typeof e !== 'object') return;
  if (e.t === 'agg' || e.t === 'sub' || e.t === 'exists') return;
  if (gkeys.has(exprKey(e))) return;
  if (e.t === 'col') {
    if (gkeys.has('col:' + String(e.name).toLowerCase())) return;
    throw err('Column "' + (e.tbl ? e.tbl + '.' : '') + e.name +
      '" must appear in GROUP BY or be used inside an aggregate function',
      'Every non-aggregated column in SELECT must also be listed in GROUP BY', 'GROUP_BY');
  }
  for (const k in e) {
    const v = e[k];
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) v.forEach((x) => checkGrouped(x, gkeys));
      else checkGrouped(v, gkeys);
    }
  }
}

function checkGroupedOrder(e, gkeys, q) {
  if (e.t === 'lit') return;
  // ORDER BY may refer to an output alias; that is already validated through SELECT.
  const isAlias = q.sel.some((s) => s.alias && e.t === 'col' && !e.tbl && s.alias.toLowerCase() === e.name.toLowerCase());
  if (isAlias) return;
  checkGrouped(e, gkeys);
}

/* Result column header: a bare column keeps its name; other expressions are rendered. */
function headerOf(e) { return e.t === 'col' ? e.name : labelOf(e); }

function labelOf(e) {
  if (e.t === 'col') return (e.tbl ? e.tbl + '.' : '') + e.name;
  if (e.t === 'agg') return e.fn + '(' + (e.star ? '*' : labelOf(e.arg)) + ')';
  if (e.t === 'call') return e.fn + '(' + e.args.map(labelOf).join(',') + ')';
  if (e.t === 'lit') return e.v === null ? 'NULL' : String(e.v);
  if (e.t === 'bin') return labelOf(e.l) + e.op + labelOf(e.r);
  return 'expr';
}

/* ============================== 5. Public API ============================== */

function validateTables(tables) {
  if (!tables || typeof tables !== 'object') throw new TypeError('createDatabase: tables must be an object');
  for (const [name, def] of Object.entries(tables)) {
    if (!Array.isArray(def.columns) || !Array.isArray(def.rows)) {
      throw new TypeError('createDatabase: table "' + name + '" needs `columns` and `rows` arrays');
    }
    def.rows.forEach((r, i) => {
      if (!Array.isArray(r) || r.length !== def.columns.length) {
        throw new TypeError('createDatabase: table "' + name + '" row ' + i + ' has the wrong number of values');
      }
    });
  }
}

/**
 * Create an in-memory, read-only database.
 * @param {Record<string, {columns: string[], rows: any[][]}>} tables
 * @param {{strict?: boolean}} [options] strict (default true) turns `= NULL` comparisons into errors
 *        instead of warnings.
 */
export function createDatabase(tables, options = {}) {
  validateTables(tables);
  const defaults = { strict: options.strict !== false };
  return {
    tables,
    run(sql, runOptions = {}) {
      const env = {
        tables,
        strict: runOptions.strict === undefined ? defaults.strict : runOptions.strict !== false,
        warnings: [],
      };
      const result = runQuery(parse(sql), null, env);
      return { columns: result.cols, rows: result.rows, warnings: env.warnings };
    },
  };
}
