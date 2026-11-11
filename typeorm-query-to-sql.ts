import { SelectQueryBuilder, QueryBuilder, ObjectLiteral } from 'typeorm';

/**
 * Turns a TypeORM QueryBuilder into plain SQL with all parameters inlined,
 * ready to paste into psql / pgAdmin / DBeaver.
 *
 * For debugging only — never execute the output from application code.
 */
export function toRawSql<T extends ObjectLiteral>(
  qb: QueryBuilder<T> | SelectQueryBuilder<T>,
): string {
  const [sql, params] = qb.getQueryAndParameters();
  return inlineParams(sql, params);
}

export function inlineParams(sql: string, params: unknown[]): string {
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    // Copy quoted strings / identifiers untouched, so "$1" inside them is not replaced
    if (ch === "'" || ch === '"') {
      const end = findClosingQuote(sql, i, ch);
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // Placeholder: $1, $2, ... $10 (regex grabs all digits, so $1 never eats $10)
    if (ch === '$') {
      const match = /^\$(\d+)/.exec(sql.slice(i));
      if (match) {
        const index = Number(match[1]) - 1;
        if (index < 0 || index >= params.length) {
          throw new Error(`No parameter for placeholder ${match[0]}`);
        }
        out += formatValue(params[index]);
        i += match[0].length;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

function findClosingQuote(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2; // escaped quote ('' or "")
        continue;
      }
      return i;
    }
    i++;
  }
  return sql.length - 1;
}

function quote(str: string): string {
  return `'${str.replace(/'/g, "''")}'`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';

  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? String(value) : quote(String(value)); // 'NaN', 'Infinity'
    case 'bigint':
      return value.toString();
    case 'boolean':
      return value ? 'TRUE' : 'FALSE';
    case 'string':
      return quote(value);
  }

  if (value instanceof Date) return quote(value.toISOString());

  if (Buffer.isBuffer(value)) return `'\\x${value.toString('hex')}'::bytea`;

  if (Array.isArray(value)) {
    // Used by ANY(:ids) / jsonb arrays etc. Empty ARRAY[] needs a type, so use '{}'
    return value.length === 0 ? `'{}'` : `ARRAY[${value.map(formatValue).join(', ')}]`;
  }

  // Plain objects -> JSON (json / jsonb columns)
  return quote(JSON.stringify(value));
}
