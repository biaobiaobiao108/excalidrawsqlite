import { AsyncLocalStorage } from "node:async_hooks";

type Trace = {
  operation: string;
  apiReadMs: number;
  apiWriteMs: number;
  transformMs: number;
  responseBuildMs: number;
  apiReads: number;
  apiWrites: number;
};
const traces = new AsyncLocalStorage<Trace>();
const round = (value: number) => Math.round(value * 1000) / 1000;

// Opt-in, one bounded record per tool; arguments, board content and tokens are never logged.
export const traceMcpTool = async <T>(
  enabled: boolean,
  operation: string,
  handler: () => Promise<T>,
): Promise<T> => {
  if (!enabled) return handler();
  const started = performance.now();
  const trace: Trace = {
    operation,
    apiReadMs: 0,
    apiWriteMs: 0,
    transformMs: 0,
    responseBuildMs: 0,
    apiReads: 0,
    apiWrites: 0,
  };
  return traces.run(trace, async () => {
    let failed = false;
    try {
      const result = await handler();
      if (
        result &&
        typeof result === "object" &&
        "structuredContent" in result
      ) {
        const content = result.structuredContent as
          { ok?: boolean } | undefined;
        failed = content?.ok === false;
      }
      return result;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      console.info(
        "[MCP timing]",
        JSON.stringify({
          ...trace,
          apiReadMs: round(trace.apiReadMs),
          apiWriteMs: round(trace.apiWriteMs),
          transformMs: round(trace.transformMs),
          responseBuildMs: round(trace.responseBuildMs),
          handlerMs: round(performance.now() - started),
          failed,
        }),
      );
    }
  });
};

export const measureMcpPhase = <T>(
  phase: "transformMs" | "responseBuildMs",
  handler: () => T,
): T => {
  const trace = traces.getStore();
  if (!trace) return handler();
  const started = performance.now();
  try {
    return handler();
  } finally {
    trace[phase] += performance.now() - started;
  }
};

export const measureMcpApi = async <T>(
  method: string,
  handler: () => Promise<T>,
): Promise<T> => {
  const trace = traces.getStore();
  if (!trace) return handler();
  const read = method === "GET";
  trace[read ? "apiReads" : "apiWrites"]++;
  const started = performance.now();
  try {
    return await handler();
  } finally {
    trace[read ? "apiReadMs" : "apiWriteMs"] += performance.now() - started;
  }
};
