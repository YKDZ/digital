import { DatabaseSync } from "node:sqlite";

import { getTableConfig, SQLiteDialect } from "drizzle-orm/sqlite-core";

import { catalogueSchema } from "./schema.ts";

export type SqliteColumnSignature = {
  readonly name: string;
  readonly type: string;
  readonly notNull: number;
  readonly defaultValue: string | null;
  readonly primaryKeyPosition: number;
  readonly hidden: number;
  readonly generatedExpression: string | null;
};

export type SqliteSchemaSignature = {
  readonly tables: Readonly<Record<string, readonly SqliteColumnSignature[]>>;
  readonly indexes: readonly string[];
  readonly triggers: readonly string[];
  readonly checks: readonly string[];
};

/**
 * 同一个物理指纹用于测试一致性和安全接管空账本 Drizzle 数据库。它从已审阅 Drizzle
 * 声明派生，而不是维护第二份手写表清单。
 */
export const reviewedCatalogueSchemaContract = schemaContractFromDrizzle();

export function inspectSqliteSchema(
  database: DatabaseSync,
): SqliteSchemaSignature {
  const tables = database
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ readonly name: string; readonly sql: string }>;
  return {
    tables: Object.fromEntries(
      tables.map((table) => [
        table.name,
        (() => {
          const generatedExpressions = generatedColumnExpressions(table.sql);
          const columns = database
            .prepare(`PRAGMA table_xinfo(${JSON.stringify(table.name)})`)
            .all() as Array<{
            readonly name: string;
            readonly type: string;
            readonly notnull: number;
            readonly dflt_value: string | null;
            readonly pk: number;
            readonly hidden: number;
          }>;
          return columns.map((column) => ({
            name: column.name,
            type: column.type,
            notNull: column.notnull,
            defaultValue: column.dflt_value,
            primaryKeyPosition: column.pk,
            hidden: column.hidden,
            generatedExpression: generatedExpressions.get(column.name) ?? null,
          }));
        })(),
      ]),
    ),
    indexes: tables
      .flatMap((table) =>
        (
          database
            .prepare(`PRAGMA index_list(${JSON.stringify(table.name)})`)
            .all() as Array<{ readonly name: string; readonly unique: number }>
        ).map((index) => {
          const columns = (
            database
              .prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`)
              .all() as Array<{ readonly seqno: number; readonly name: string }>
          )
            .toSorted((left, right) => left.seqno - right.seqno)
            .map((column) => column.name);
          return `${table.name}|${index.unique}|${columns.join(",")}`;
        }),
      )
      .toSorted(),
    triggers: (
      database
        .prepare(
          "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
        )
        .all() as Array<{
        readonly name: string;
        readonly tbl_name: string;
        readonly sql: string;
      }>
    ).map((trigger) =>
      [trigger.name, trigger.tbl_name, normalizeSql(trigger.sql)].join("|"),
    ),
    checks: tables
      .flatMap((table) =>
        checkClauses(table.sql).map((clause) => `${table.name}|${clause}`),
      )
      .toSorted(),
  };
}

export function readSqliteSchemaSignature(
  databasePath: string,
): SqliteSchemaSignature {
  const database = new DatabaseSync(databasePath);
  try {
    return inspectSqliteSchema(database);
  } finally {
    database.close();
  }
}

/** 损坏或仅名称相似的数据库绝不能建立基线。 */
export function matchesReviewedCatalogueSchema(
  database: DatabaseSync,
): boolean {
  const signature = inspectSqliteSchema(database);
  return (
    schemaSignaturesEqual(signature, reviewedCatalogueSchemaContract) &&
    hasWorkflowExecutionAuditContract(signature)
  );
}

export function schemaSignaturesEqual(
  left: SqliteSchemaSignature,
  right: SqliteSchemaSignature,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function schemaContractFromDrizzle(): SqliteSchemaSignature {
  const tableContracts = Object.values(catalogueSchema)
    .map((table) => {
      const config = getTableConfig(table);
      const primaryKeyColumns = primaryKeyColumnsFor(config);
      const dialect = new SQLiteDialect();
      const columns = config.columns.map((column) => {
        const sqlType = column.getSQLType();
        const primaryKeyPosition = primaryKeyColumns.indexOf(column.name) + 1;
        return {
          name: column.name,
          type: physicalColumnType(sqlType),
          notNull: physicalNotNull(
            column.notNull,
            sqlType,
            primaryKeyPosition,
            primaryKeyColumns.length,
          ),
          defaultValue: physicalDefault(column.default, sqlType),
          primaryKeyPosition,
          hidden:
            column.generated === undefined
              ? 0
              : column.generated.mode === "stored"
                ? 3
                : 2,
          generatedExpression: generatedExpressionFromDrizzle(dialect, column),
        };
      });
      const indexes = [
        ...config.indexes.map((index) =>
          indexSignature(
            config.name,
            index.config.unique ? 1 : 0,
            index.config.columns.map(columnName),
          ),
        ),
        ...config.uniqueConstraints.map((constraint) =>
          indexSignature(
            config.name,
            1,
            constraint.columns.map((column) => column.name),
          ),
        ),
        ...(hasPhysicalPrimaryKeyIndex(config, primaryKeyColumns)
          ? [indexSignature(config.name, 1, primaryKeyColumns)]
          : []),
      ];
      const checks = config.checks.map(
        (check) =>
          `${config.name}|${normalizedGeneratedExpression(
            dialect.sqlToQuery(check.value).sql,
          )}`,
      );
      return [config.name, { columns, indexes, checks }] as const;
    })
    .toSorted(([left], [right]) => left.localeCompare(right));
  return {
    tables: Object.fromEntries(
      tableContracts.map(([name, contract]) => [name, contract.columns]),
    ),
    indexes: tableContracts
      .flatMap(([, contract]) => contract.indexes)
      .toSorted(),
    triggers: [],
    checks: tableContracts
      .flatMap(([, contract]) => contract.checks)
      .toSorted(),
  };
}

function primaryKeyColumnsFor(
  config: ReturnType<typeof getTableConfig>,
): string[] {
  const tablePrimaryKey = config.primaryKeys[0];
  if (tablePrimaryKey !== undefined)
    return tablePrimaryKey.columns.map((column) => column.name);
  return config.columns
    .filter((column) => column.primary)
    .map((column) => column.name);
}

function hasPhysicalPrimaryKeyIndex(
  config: ReturnType<typeof getTableConfig>,
  primaryKeyColumns: readonly string[],
): boolean {
  if (primaryKeyColumns.length === 0) return false;
  const integerRowidPrimaryKey =
    primaryKeyColumns.length === 1 &&
    config.columns.some(
      (column) =>
        column.name === primaryKeyColumns[0] &&
        physicalColumnType(column.getSQLType()) === "INTEGER",
    );
  return !integerRowidPrimaryKey;
}

function columnName(column: unknown): string {
  if (
    typeof column === "object" &&
    column !== null &&
    "name" in column &&
    typeof column.name === "string"
  ) {
    return column.name;
  }
  throw new Error("Reviewed Drizzle index contains an unnamed column");
}

function indexSignature(
  tableName: string,
  unique: number,
  columns: readonly string[],
): string {
  return `${tableName}|${unique}|${columns.join(",")}`;
}

function physicalColumnType(sqlType: string): string {
  return sqlType.trim().split(/\s+/u)[0]!.toUpperCase();
}

function physicalNotNull(
  declaredNotNull: boolean,
  sqlType: string,
  primaryKeyPosition: number,
  primaryKeyColumnCount: number,
): number {
  if (/\bNOT\s+NULL\b/iu.test(sqlType)) return 1;
  // 即使 Drizzle 把列标为必需，SQLite 对内联 INTEGER PRIMARY KEY 仍报告
  // `notnull = 0`。这是已审阅契约中保留的唯一 Drizzle Kit 专用物理规则。
  if (
    primaryKeyPosition === 1 &&
    primaryKeyColumnCount === 1 &&
    physicalColumnType(sqlType) === "INTEGER"
  )
    return 0;
  return declaredNotNull ? 1 : 0;
}

function physicalDefault(value: unknown, sqlType: string): string | null {
  if (value === undefined) return null;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (physicalColumnType(sqlType) !== "TEXT")
      throw new Error(
        "Reviewed Drizzle default must have a SQLite literal encoder",
      );
    return `'${value.replaceAll("'", "''")}'`;
  }
  throw new Error(
    "Reviewed Drizzle default must have a SQLite literal encoder",
  );
}

function hasWorkflowExecutionAuditContract(
  signature: SqliteSchemaSignature,
): boolean {
  const auditColumn = signature.tables.workflow_executions?.find(
    (column) => column.name === "audit_json",
  );
  if (
    auditColumn === undefined ||
    auditColumn.type !== "TEXT" ||
    auditColumn.notNull !== 0 ||
    auditColumn.defaultValue !== null
  )
    return false;
  // 物理契约刻意只允许 0031 前的行使用 NULL。新写入在装载时验证审计封装版本。
  return true;
}

function generatedExpressionFromDrizzle(
  dialect: SQLiteDialect,
  column: ReturnType<typeof getTableConfig>["columns"][number],
): string | null {
  if (column.generated === undefined) return null;
  const rendered = dialect.sqlToQuery(
    typeof column.generated.as === "function"
      ? column.generated.as()
      : column.generated.as,
  );
  if (rendered.params.length !== 0) {
    throw new Error("Reviewed generated column expression must be literal SQL");
  }
  return normalizedGeneratedExpression(rendered.sql);
}

function generatedColumnExpressions(
  createTableSql: string,
): ReadonlyMap<string, string> {
  const definitions = tableColumnDefinitions(createTableSql);
  const generated = new Map<string, string>();
  for (const definition of definitions) {
    const identifier = readSqlIdentifier(definition, 0);
    if (identifier === undefined) continue;
    const expression = generatedExpressionInColumn(definition, identifier.end);
    if (expression !== undefined) {
      generated.set(
        identifier.value,
        normalizedGeneratedExpression(expression),
      );
    }
  }
  return generated;
}

function tableColumnDefinitions(createTableSql: string): readonly string[] {
  const open = findSqlCharacter(createTableSql, 0, "(");
  if (open === undefined) return [];
  const close = matchingSqlParenthesis(createTableSql, open);
  if (close === undefined) return [];
  const definitions: string[] = [];
  let start = open + 1;
  let cursor = start;
  let depth = 0;
  while (cursor < close) {
    const triviaEnd = skipSqlTrivia(createTableSql, cursor);
    if (triviaEnd !== cursor) {
      cursor = triviaEnd;
      continue;
    }
    const quotedEnd = quotedSqlEnd(createTableSql, cursor);
    if (quotedEnd !== undefined) {
      cursor = quotedEnd;
      continue;
    }
    const character = createTableSql[cursor];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      definitions.push(createTableSql.slice(start, cursor).trim());
      start = cursor + 1;
    }
    cursor += 1;
  }
  const finalDefinition = createTableSql.slice(start, close).trim();
  if (finalDefinition.length > 0) definitions.push(finalDefinition);
  return definitions;
}

function generatedExpressionInColumn(
  definition: string,
  start: number,
): string | undefined {
  let cursor = start;
  let depth = 0;
  while (cursor < definition.length) {
    const triviaEnd = skipSqlTrivia(definition, cursor);
    if (triviaEnd !== cursor) {
      cursor = triviaEnd;
      continue;
    }
    const quotedEnd = quotedSqlEnd(definition, cursor);
    if (quotedEnd !== undefined) {
      cursor = quotedEnd;
      continue;
    }
    const character = definition[cursor];
    if (character === "(") {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      cursor += 1;
      continue;
    }
    const word = readSqlWord(definition, cursor);
    if (word === undefined) {
      cursor += 1;
      continue;
    }
    cursor = word.end;
    if (depth !== 0 || word.value.toUpperCase() !== "GENERATED") continue;
    let next = readNextSqlWord(definition, cursor);
    if (next?.value.toUpperCase() === "ALWAYS") {
      cursor = next.end;
      next = readNextSqlWord(definition, cursor);
    }
    if (next?.value.toUpperCase() !== "AS") continue;
    cursor = skipSqlTrivia(definition, next.end);
    if (definition[cursor] !== "(") continue;
    const close = matchingSqlParenthesis(definition, cursor);
    if (close === undefined) return undefined;
    return definition.slice(cursor + 1, close);
  }
  return undefined;
}

function normalizedGeneratedExpression(expression: string): string {
  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < expression.length) {
    const triviaEnd = skipSqlTrivia(expression, cursor);
    if (triviaEnd !== cursor) {
      cursor = triviaEnd;
      continue;
    }
    const character = expression[cursor];
    if (character === "'") {
      const quoted = readQuotedSql(expression, cursor);
      if (quoted === undefined)
        throw new Error("Generated column expression has an open string");
      tokens.push(`string:${JSON.stringify(quoted.value)}`);
      cursor = quoted.end;
      continue;
    }
    if (character === '"' || character === "`" || character === "[") {
      const quoted = readQuotedSql(expression, cursor);
      if (quoted === undefined)
        throw new Error("Generated column expression has an open identifier");
      tokens.push(`word:${quoted.value.toLocaleLowerCase("en-US")}`);
      cursor = quoted.end;
      continue;
    }
    const word = readSqlWord(expression, cursor);
    if (word !== undefined) {
      tokens.push(`word:${word.value.toLocaleLowerCase("en-US")}`);
      cursor = word.end;
      continue;
    }
    const number = /^[0-9]+(?:\.[0-9]+)?/u.exec(expression.slice(cursor));
    if (number !== null) {
      tokens.push(`number:${number[0]}`);
      cursor += number[0].length;
      continue;
    }
    const operator = ["->>", "||", "->", "<=", ">=", "<>", "!=", "=="].find(
      (candidate) => expression.startsWith(candidate, cursor),
    );
    if (operator !== undefined) {
      tokens.push(`symbol:${operator}`);
      cursor += operator.length;
      continue;
    }
    tokens.push(`symbol:${character}`);
    cursor += 1;
  }
  return tokens.join("\u001f");
}

function readSqlIdentifier(
  value: string,
  start: number,
): { readonly value: string; readonly end: number } | undefined {
  const cursor = skipSqlTrivia(value, start);
  const character = value[cursor];
  if (character === '"' || character === "`" || character === "[") {
    return readQuotedSql(value, cursor);
  }
  return readSqlWord(value, cursor);
}

function readNextSqlWord(
  value: string,
  start: number,
): { readonly value: string; readonly end: number } | undefined {
  return readSqlWord(value, skipSqlTrivia(value, start));
}

function readSqlWord(
  value: string,
  start: number,
): { readonly value: string; readonly end: number } | undefined {
  const match = /^[\p{L}_][\p{L}\p{N}_$]*/u.exec(value.slice(start));
  return match === null
    ? undefined
    : { value: match[0], end: start + match[0].length };
}

function readQuotedSql(
  value: string,
  start: number,
): { readonly value: string; readonly end: number } | undefined {
  const opening = value[start];
  if (opening !== "'" && opening !== '"' && opening !== "`" && opening !== "[")
    return undefined;
  const closing = opening === "[" ? "]" : opening;
  let decoded = "";
  let cursor = start + 1;
  while (cursor < value.length) {
    const character = value[cursor];
    if (character !== closing) {
      decoded += character;
      cursor += 1;
      continue;
    }
    if (value[cursor + 1] === closing) {
      decoded += closing;
      cursor += 2;
      continue;
    }
    return { value: decoded, end: cursor + 1 };
  }
  return undefined;
}

function quotedSqlEnd(value: string, start: number): number | undefined {
  return readQuotedSql(value, start)?.end;
}

function skipSqlTrivia(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length) {
    const whitespace = /^\s+/u.exec(value.slice(cursor));
    if (whitespace !== null) {
      cursor += whitespace[0].length;
      continue;
    }
    if (value.startsWith("--", cursor)) {
      const newline = value.indexOf("\n", cursor + 2);
      cursor = newline === -1 ? value.length : newline + 1;
      continue;
    }
    if (value.startsWith("/*", cursor)) {
      const close = value.indexOf("*/", cursor + 2);
      cursor = close === -1 ? value.length : close + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function findSqlCharacter(
  value: string,
  start: number,
  target: string,
): number | undefined {
  let cursor = start;
  while (cursor < value.length) {
    const triviaEnd = skipSqlTrivia(value, cursor);
    if (triviaEnd !== cursor) {
      cursor = triviaEnd;
      continue;
    }
    const quotedEnd = quotedSqlEnd(value, cursor);
    if (quotedEnd !== undefined) {
      cursor = quotedEnd;
      continue;
    }
    if (value[cursor] === target) return cursor;
    cursor += 1;
  }
  return undefined;
}

function matchingSqlParenthesis(
  value: string,
  open: number,
): number | undefined {
  if (value[open] !== "(") return undefined;
  let depth = 1;
  let cursor = open + 1;
  while (cursor < value.length) {
    const triviaEnd = skipSqlTrivia(value, cursor);
    if (triviaEnd !== cursor) {
      cursor = triviaEnd;
      continue;
    }
    const quotedEnd = quotedSqlEnd(value, cursor);
    if (quotedEnd !== undefined) {
      cursor = quotedEnd;
      continue;
    }
    if (value[cursor] === "(") depth += 1;
    else if (value[cursor] === ")") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  return undefined;
}

function normalizeSql(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function checkClauses(sql: string): readonly string[] {
  const clauses: string[] = [];
  let cursor = 0;
  while (cursor < sql.length) {
    const triviaEnd = skipSqlTrivia(sql, cursor);
    if (triviaEnd !== cursor) {
      cursor = triviaEnd;
      continue;
    }
    const quotedEnd = quotedSqlEnd(sql, cursor);
    if (quotedEnd !== undefined) {
      cursor = quotedEnd;
      continue;
    }
    const word = readSqlWord(sql, cursor);
    if (word === undefined) {
      cursor += 1;
      continue;
    }
    cursor = word.end;
    if (word.value.toUpperCase() !== "CHECK") continue;
    const open = skipSqlTrivia(sql, cursor);
    if (sql[open] !== "(") continue;
    const close = matchingSqlParenthesis(sql, open);
    if (close === undefined) continue;
    clauses.push(normalizedGeneratedExpression(sql.slice(open + 1, close)));
    cursor = close + 1;
  }
  return clauses;
}
