export type D1Value = string | number | null | Uint8Array;
export type D1RunResult = { changes: number; lastRowId?: number };
export type D1Statement = { sql: string; values?: readonly D1Value[] };
export type MaybePromise<T> = T | Promise<T>;

export type D1PreparedStatement = {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ success: boolean; results?: T[]; error?: string }>;
  run<T = Record<string, unknown>>(): Promise<{ success: boolean; meta?: { changes?: number; last_row_id?: number }; error?: string }>;
};
export type D1Binding = {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<Array<{ success: boolean; results?: T[]; meta?: { changes?: number; last_row_id?: number }; error?: string }>>;
};

export type D1QueryPort = {
  get<T = Record<string, unknown>>(...values: D1Value[]): MaybePromise<T | null>;
  all<T = Record<string, unknown>>(...values: D1Value[]): MaybePromise<T[]>;
  run(...values: D1Value[]): MaybePromise<D1RunResult>;
};
export type D1DatabasePort = {
  query(sql: string): D1QueryPort;
  run(sql: string, values?: readonly D1Value[]): MaybePromise<D1RunResult>;
  batch(statements: readonly D1Statement[]): MaybePromise<D1RunResult[]>;
  close?: () => void;
  checkpoint?: () => void;
};

const assertSuccess = (result: { success: boolean; error?: string }, label: string) => {
  if (!result.success) throw new Error(result.error || `Cloudflare D1 ${label} failed`);
};

export class CloudflareD1Adapter implements D1DatabasePort {
  private readonly queries = new Map<string, D1QueryPort>();

  constructor(private readonly binding: D1Binding) {}

  query(sql: string): D1QueryPort {
    let query = this.queries.get(sql);
    if (!query) {
      query = {
        get: async <T>(...values: D1Value[]) =>
          this.binding.prepare(sql).bind(...values).first<T>(),
        all: async <T>(...values: D1Value[]) => {
          const result = await this.binding.prepare(sql).bind(...values).all<T>();
          assertSuccess(result, "query");
          return result.results || [];
        },
        run: async (...values: D1Value[]) => {
          const result = await this.binding.prepare(sql).bind(...values).run();
          assertSuccess(result, "write");
          return {
            changes: Number(result.meta?.changes || 0),
            lastRowId: result.meta?.last_row_id,
          };
        },
      };
      this.queries.set(sql, query);
    }
    return query;
  }

  run(sql: string, values: readonly D1Value[] = []) {
    return this.query(sql).run(...values);
  }

  async batch(statements: readonly D1Statement[]) {
    if (!statements.length) return [];
    const results = await this.binding.batch(
      statements.map(({ sql, values = [] }) => this.binding.prepare(sql).bind(...values)),
    );
    return results.map((result) => {
      assertSuccess(result, "batch");
      return {
        changes: Number(result.meta?.changes || 0),
        lastRowId: result.meta?.last_row_id,
      };
    });
  }
}

const adapterCache = new WeakMap<object, CloudflareD1Adapter>();
export const databaseFromBinding = (binding: D1Binding) => {
  const key = binding as object;
  let adapter = adapterCache.get(key);
  if (!adapter) {
    adapter = new CloudflareD1Adapter(binding);
    adapterCache.set(key, adapter);
  }
  return adapter;
};
