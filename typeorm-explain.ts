import { DataSource, ObjectLiteral, QueryBuilder } from 'typeorm';
import { inlineParams } from './typeorm-query-to-sql';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface PlanNode {
  'Node Type': string;
  'Parent Relationship'?: string;
  'Relation Name'?: string;
  Schema?: string;
  Alias?: string;
  'Index Name'?: string;
  'Plan Rows': number;
  'Actual Rows': number;
  'Actual Loops': number;
  'Actual Total Time': number;
  Filter?: string;
  'Index Cond'?: string;
  'Recheck Cond'?: string;
  'Join Filter'?: string;
  'Hash Cond'?: string;
  'Merge Cond'?: string;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Join Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Sort Key'?: string[];
  'Sort Method'?: string;
  'Sort Space Type'?: string;
  'Sort Space Used'?: number;
  'Hash Batches'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Temp Read Blocks'?: number;
  'Temp Written Blocks'?: number;
  Plans?: PlanNode[];
}

interface ExplainJson {
  Plan: PlanNode;
  'Planning Time': number;
  'Execution Time': number;
}

interface TableRef {
  schema: string;
  table: string;
}

interface ColumnRef {
  alias: string;
  column: string;
  equality: boolean;
}

export interface IndexSuggestion extends TableRef {
  columns: string[];
  reason: string;
  severity: 'high' | 'medium';
  ddl: string;
  existingIndex?: string;
  needsExpressionIndex?: boolean;
}

export interface PlanWarning {
  severity: 'medium' | 'info';
  message: string;
}

export interface ExplainReport {
  sql: string;
  planningTimeMs: number;
  executionTimeMs: number;
  plan: PlanNode;
  suggestions: IndexSuggestion[];
  warnings: PlanWarning[];
}

export interface ExplainOptions {
  /** Ignore seq scans on tables that produced fewer rows than this (default 1000). */
  minRows?: number;
  /** Rows-removed / rows-scanned ratio that counts as "unselective" (default 0.5). */
  minRemovedRatio?: number;
  /** Planner estimate vs actual rows factor that triggers a stats warning (default 10). */
  estimateErrorFactor?: number;
  /** Roll back after EXPLAIN ANALYZE so INSERT/UPDATE/DELETE leave no trace (default true). */
  rollback?: boolean;
  printSql?: boolean;
  printPlan?: boolean;
}

const DEFAULTS: Required<ExplainOptions> = {
  minRows: 1000,
  minRemovedRatio: 0.5,
  estimateErrorFactor: 10,
  rollback: true,
  printSql: true,
  printPlan: true,
};

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function explainQuery<T extends ObjectLiteral>(
  dataSource: DataSource,
  qb: QueryBuilder<T>,
  options: ExplainOptions = {},
): Promise<ExplainReport> {
  const [sql, params] = qb.getQueryAndParameters();
  return explainRaw(dataSource, sql, params, options);
}

export async function explainRaw(
  dataSource: DataSource,
  sql: string,
  params: unknown[] = [],
  options: ExplainOptions = {},
): Promise<ExplainReport> {
  const opts = { ...DEFAULTS, ...options };
  const explain = await runExplain(dataSource, sql, params, opts.rollback);

  const aliases = new Map<string, TableRef>();
  collectAliases(explain.Plan, aliases);

  const suggestions: IndexSuggestion[] = [];
  const warnings: PlanWarning[] = [];
  analyzeNode(explain.Plan, undefined, aliases, opts, suggestions, warnings);

  const merged = dedupeSuggestions(suggestions);
  await markExistingIndexes(dataSource, merged);

  const report: ExplainReport = {
    sql: inlineParams(sql, params),
    planningTimeMs: explain['Planning Time'],
    executionTimeMs: explain['Execution Time'],
    plan: explain.Plan,
    suggestions: merged,
    warnings,
  };

  printReport(report, opts);
  return report;
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

async function runExplain(
  dataSource: DataSource,
  sql: string,
  params: unknown[],
  rollback: boolean,
): Promise<ExplainJson> {
  const qr = dataSource.createQueryRunner();
  await qr.connect();
  try {
    // ANALYZE really executes the statement, so wrap it in a transaction we can roll back
    await qr.startTransaction();
    const rows = await qr.query(
      `EXPLAIN (ANALYZE, COSTS, VERBOSE, BUFFERS, FORMAT JSON) ${sql}`,
      params,
    );
    if (rollback) await qr.rollbackTransaction();
    else await qr.commitTransaction();

    const raw = rows[0]['QUERY PLAN'];
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed[0] as ExplainJson;
  } catch (err) {
    if (qr.isTransactionActive) await qr.rollbackTransaction();
    throw err;
  } finally {
    await qr.release();
  }
}

/* ------------------------------------------------------------------ */
/* Plan analysis                                                       */
/* ------------------------------------------------------------------ */

function collectAliases(node: PlanNode, map: Map<string, TableRef>): void {
  if (node['Relation Name']) {
    map.set(node.Alias ?? node['Relation Name'], {
      schema: node.Schema ?? 'public',
      table: node['Relation Name'],
    });
  }
  node.Plans?.forEach((child) => collectAliases(child, map));
}

function analyzeNode(
  node: PlanNode,
  parent: PlanNode | undefined,
  aliases: Map<string, TableRef>,
  opts: Required<ExplainOptions>,
  suggestions: IndexSuggestion[],
  warnings: PlanWarning[],
): void {
  const type = node['Node Type'];
  const loops = node['Actual Loops'] || 1;
  const returned = node['Actual Rows'] * loops;
  const removed = (node['Rows Removed by Filter'] ?? 0) * loops;
  const scanned = returned + removed;
  const removedRatio = scanned > 0 ? removed / scanned : 0;
  const where = node.Alias ? `${node.Schema}.${node['Relation Name']} (${node.Alias})` : '';

  // 1. Seq Scan inside a Nested Loop that runs many times: the classic missing join index
  if (type === 'Seq Scan' && loops > 1 && parent?.['Node Type'] === 'Nested Loop') {
    const expr = [parent['Join Filter'], node.Filter].filter(Boolean).join(' AND ');
    addSuggestion(
      suggestions, aliases, expr, node.Alias, 'high',
      `Seq Scan on ${where} executed ${loops}x as inner side of Nested Loop`,
    );
  }
  // 2. Seq Scan throwing away most rows
  else if (
    type === 'Seq Scan' &&
    node.Filter &&
    scanned >= opts.minRows &&
    removedRatio >= opts.minRemovedRatio
  ) {
    addSuggestion(
      suggestions, aliases, node.Filter, node.Alias, 'high',
      `Seq Scan on ${where} read ${fmt(scanned)} rows, discarded ${pct(removedRatio)} by filter`,
    );
  }

  // 3. Index used, but the filter after it removes most rows: index lacks columns
  if (
    /Index Scan|Index Only Scan|Bitmap Heap Scan/.test(type) &&
    node.Filter &&
    removed >= opts.minRows &&
    removedRatio >= opts.minRemovedRatio
  ) {
    const indexCond = node['Index Cond'] ?? node['Recheck Cond'] ?? '';
    addSuggestion(
      suggestions, aliases, [indexCond, node.Filter].filter(Boolean).join(' AND '), node.Alias, 'medium',
      `${type} on ${where}${node['Index Name'] ? ` using ${node['Index Name']}` : ''} ` +
        `discarded ${fmt(removed)} rows (${pct(removedRatio)}) after the index lookup — composite index`,
    );
  }

  // 4. Lossy bitmap
  if ((node['Rows Removed by Index Recheck'] ?? 0) * loops >= opts.minRows) {
    warnings.push({
      severity: 'info',
      message: `Lossy bitmap on ${where}: ${fmt(node['Rows Removed by Index Recheck']! * loops)} rows removed by recheck — consider raising work_mem`,
    });
  }

  // 5. Sort spilled to disk
  if (type === 'Sort' && node['Sort Space Type'] === 'Disk') {
    warnings.push({
      severity: 'medium',
      message: `Sort spilled to disk (${node['Sort Method']}, ${fmt(node['Sort Space Used'] ?? 0)} kB) on ` +
        `[${(node['Sort Key'] ?? []).join(', ')}] — raise work_mem or add an index matching the ORDER BY`,
    });
    const sortExpr = (node['Sort Key'] ?? []).map((k) => k.replace(/\s+(ASC|DESC).*$/i, '')).join(' , ');
    addSuggestion(suggestions, aliases, sortExpr, undefined, 'medium', 'Sort spilled to disk, index on sort keys could avoid it');
  }

  // 6. Hash join spilling into batches
  if (type === 'Hash' && (node['Hash Batches'] ?? 1) > 1) {
    warnings.push({
      severity: 'medium',
      message: `Hash used ${node['Hash Batches']} batches (spilled to disk) — raise work_mem`,
    });
  }

  // 7. Bad row estimates => stale statistics
  const est = node['Plan Rows'];
  const act = node['Actual Rows'];
  if (
    Math.max(est, act) >= 100 &&
    Math.max(est, act) / Math.max(1, Math.min(est, act)) >= opts.estimateErrorFactor
  ) {
    warnings.push({
      severity: 'info',
      message: `${type}${where ? ` on ${where}` : ''}: planner estimated ${fmt(est)} rows, got ${fmt(act)} — ` +
        (node['Relation Name'] ? `run ANALYZE ${node.Schema}.${node['Relation Name']};` : 'check statistics'),
    });
  }

  node.Plans?.forEach((child) => analyzeNode(child, node, aliases, opts, suggestions, warnings));
}

/* ------------------------------------------------------------------ */
/* Column extraction from plan expressions                             */
/* ------------------------------------------------------------------ */

const IDENT = `(?:"((?:[^"]|"")+)"|([a-z_][a-z0-9_$]*))`;
const COLUMN_RE = new RegExp(`${IDENT}\\.${IDENT}`, 'gi');
const EQUALITY_AFTER_RE = /^[)\s]*(?:::[a-z_ ]+(?:\[\])?[)\s]*)*(=|IS NULL)/i;
const FUNCTION_WRAP_RE = /\b(lower|upper|date|date_trunc|coalesce|to_char|trim|extract)\s*\(/i;

function extractColumns(expr: string): ColumnRef[] {
  // drop string literals so 'a@b.com' is not mistaken for alias.column
  const clean = expr.replace(/'(?:[^']|'')*'/g, "''");
  const out: ColumnRef[] = [];
  for (const m of clean.matchAll(COLUMN_RE)) {
    const alias = m[1] ?? m[2];
    const column = m[3] ?? m[4];
    const after = clean.slice(m.index! + m[0].length);
    out.push({ alias, column, equality: EQUALITY_AFTER_RE.test(after) });
  }
  return out;
}

function addSuggestion(
  suggestions: IndexSuggestion[],
  aliases: Map<string, TableRef>,
  expr: string | undefined,
  onlyAlias: string | undefined,
  severity: IndexSuggestion['severity'],
  reason: string,
): void {
  if (!expr) return;

  const byAlias = new Map<string, ColumnRef[]>();
  for (const col of extractColumns(expr)) {
    if (onlyAlias && col.alias !== onlyAlias) continue;
    if (!aliases.has(col.alias)) continue;
    const list = byAlias.get(col.alias) ?? [];
    if (!list.some((c) => c.column === col.column)) list.push(col);
    byAlias.set(col.alias, list);
  }

  for (const [alias, cols] of byAlias) {
    const ref = aliases.get(alias)!;
    // equality columns first, then range / sort columns
    const columns = [...cols.filter((c) => c.equality), ...cols.filter((c) => !c.equality)]
      .map((c) => c.column);
    suggestions.push({
      ...ref,
      columns,
      reason,
      severity,
      ddl: buildDdl(ref, columns),
      needsExpressionIndex: FUNCTION_WRAP_RE.test(expr),
    });
  }
}

function buildDdl(ref: TableRef, columns: string[]): string {
  const name = `idx_${ref.table}_${columns.join('_')}`.slice(0, 63);
  const cols = columns.map((c) => `"${c}"`).join(', ');
  return `CREATE INDEX CONCURRENTLY "${name}" ON "${ref.schema}"."${ref.table}" (${cols});`;
}

function dedupeSuggestions(list: IndexSuggestion[]): IndexSuggestion[] {
  const seen = new Map<string, IndexSuggestion>();
  for (const s of list) {
    const key = `${s.schema}.${s.table}(${s.columns.join(',')})`;
    const prev = seen.get(key);
    if (!prev || (prev.severity === 'medium' && s.severity === 'high')) seen.set(key, s);
  }
  return [...seen.values()];
}

/* ------------------------------------------------------------------ */
/* Existing index lookup                                               */
/* ------------------------------------------------------------------ */

async function markExistingIndexes(dataSource: DataSource, suggestions: IndexSuggestion[]): Promise<void> {
  const tables = new Map<string, TableRef>();
  suggestions.forEach((s) => tables.set(`${s.schema}.${s.table}`, s));

  for (const [key, ref] of tables) {
    const indexes: { index_name: string; columns: (string | null)[] }[] = await dataSource.query(
      `SELECT i.relname AS index_name,
              array_agg(a.attname::text ORDER BY k.ord) AS columns
         FROM pg_index ix
         JOIN pg_class t      ON t.oid = ix.indrelid
         JOIN pg_namespace n  ON n.oid = t.relnamespace
         JOIN pg_class i      ON i.oid = ix.indexrelid
         CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
         LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE n.nspname = $1 AND t.relname = $2
        GROUP BY i.relname`,
      [ref.schema, ref.table],
    );

    for (const s of suggestions.filter((x) => `${x.schema}.${x.table}` === key)) {
      const hit = indexes.find((idx) =>
        s.columns.every((col, i) => idx.columns[i] === col),
      );
      if (hit) s.existingIndex = hit.index_name;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

function printReport(r: ExplainReport, opts: Required<ExplainOptions>): void {
  const line = '─'.repeat(80);
  console.log(`\n${line}\nEXPLAIN ANALYZE REPORT\n${line}`);

  if (opts.printSql) console.log(`\nSQL:\n${r.sql}\n`);

  if (opts.printPlan) {
    console.log('Plan:');
    printNode(r.plan, 0);
  }

  const root = r.plan;
  console.log(
    `\nPlanning time:  ${r.planningTimeMs.toFixed(3)} ms` +
      `\nExecution time: ${r.executionTimeMs.toFixed(3)} ms` +
      `\nBuffers:        shared hit=${fmt(root['Shared Hit Blocks'] ?? 0)} read=${fmt(root['Shared Read Blocks'] ?? 0)}` +
      `  temp read=${fmt(root['Temp Read Blocks'] ?? 0)} written=${fmt(root['Temp Written Blocks'] ?? 0)}`,
  );

  if (r.suggestions.length === 0) {
    console.log('\nPossible missing indexes: none detected');
  } else {
    console.log('\nPossible missing indexes:');
    for (const s of r.suggestions) {
      console.log(`  [${s.severity.toUpperCase()}] ${s.reason}`);
      if (s.existingIndex) {
        console.log(
          `     Index "${s.existingIndex}" already covers (${s.columns.join(', ')}) but was not used — ` +
            'check type casts, functions on the column, low selectivity or stale stats',
        );
      } else {
        console.log(`     ${s.ddl}`);
      }
      if (s.needsExpressionIndex) {
        console.log('     Note: column is wrapped in a function; a plain index won\'t help, use an expression index');
      }
    }
  }

  if (r.warnings.length) {
    console.log('\nOther warnings:');
    r.warnings.forEach((w) => console.log(`  [${w.severity.toUpperCase()}] ${w.message}`));
  }
  console.log(line + '\n');
}

function printNode(node: PlanNode, depth: number): void {
  const parts = [node['Node Type']];
  if (node['Relation Name']) parts.push(`on ${node.Schema}.${node['Relation Name']} ${node.Alias ?? ''}`.trim());
  if (node['Index Name']) parts.push(`using ${node['Index Name']}`);

  const removed = node['Rows Removed by Filter'];
  const stats =
    `time=${node['Actual Total Time'].toFixed(2)}ms rows=${fmt(node['Actual Rows'])}` +
    ` (est ${fmt(node['Plan Rows'])}) loops=${node['Actual Loops']}` +
    (removed ? ` removed=${fmt(removed)}` : '');

  console.log(`${'  '.repeat(depth)}-> ${parts.join(' ')}  [${stats}]`);
  node.Plans?.forEach((child) => printNode(child, depth + 1));
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
