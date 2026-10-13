import type { Database } from "bun:sqlite";
import type { D1DatabasePort, D1RunResult, D1Statement } from "./db";

/** SQLite adapter used only by Bun tests and local compatibility helpers. */
export class BunDatabaseAdapter implements D1DatabasePort {
  constructor(private readonly sqlite: Database) {}

  query(sql: string) {
    return {
      get: <T = Record<string, unknown>>(...values: Array<string | number | null | Uint8Array>) =>
        (this.sqlite.query(sql).get(...values) as T | null) ?? null,
      all: <T = Record<string, unknown>>(...values: Array<string | number | null | Uint8Array>) =>
        this.sqlite.query(sql).all(...values) as T[],
      run: (...values: Array<string | number | null | Uint8Array>) => {
        const result = this.sqlite.query(sql).run(...values);
        return { changes: result.changes, lastRowId: Number(result.lastInsertRowid) } satisfies D1RunResult;
      },
    };
  }

  run(sql: string, values: readonly (string | number | null | Uint8Array)[] = []) {
    return this.query(sql).run(...values);
  }

  async batch(statements: readonly D1Statement[]) {
    const transaction = this.sqlite.transaction(() => statements.map(({ sql, values = [] }) => {
      const result = this.sqlite.query(sql).run(...values);
      return { changes: result.changes, lastRowId: Number(result.lastInsertRowid) } satisfies D1RunResult;
    }));
    return transaction();
  }

  close() { this.sqlite.close(); }
  checkpoint() { this.sqlite.run("PRAGMA wal_checkpoint(TRUNCATE);"); }

  prepare(sql: string) { return this.sqlite.query(sql); }
  transaction<T extends (...args: any[]) => any>(callback: T) {
    return this.sqlite.transaction(callback);
  }
}
