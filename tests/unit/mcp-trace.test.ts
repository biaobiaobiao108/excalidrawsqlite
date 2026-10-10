import { expect, it, spyOn } from "bun:test";
import { measureMcpApi, measureMcpPhase, traceMcpTool } from "../../server/mcp-trace";

it("MCP timing is opt-in and isolates concurrent calls without retaining payloads", async () => {
  const log = spyOn(console, "info").mockImplementation(() => {});
  try {
    await traceMcpTool(false, "disabled", () => measureMcpApi("GET", async () => 1));
    expect(log).not.toHaveBeenCalled();
    await Promise.all([
      traceMcpTool(true, "read", async () => {
        await measureMcpApi("GET", async () => Promise.resolve());
        return measureMcpPhase("responseBuildMs", () => ({ structuredContent: { ok: true } }));
      }),
      traceMcpTool(true, "write", async () => {
        measureMcpPhase("transformMs", () => 1);
        await measureMcpApi("PUT", async () => Promise.resolve());
        return { structuredContent: { ok: false } };
      }),
    ]);
    const records = log.mock.calls.map((call) => JSON.parse(call[1] as string));
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.operation === "read")).toMatchObject({ apiReads: 1, apiWrites: 0, failed: false });
    expect(records.find((record) => record.operation === "write")).toMatchObject({ apiReads: 0, apiWrites: 1, failed: true });
    for (const record of records) {
      for (const key of ["apiReadMs", "apiWriteMs", "transformMs", "responseBuildMs", "handlerMs"])
        expect(record[key]).toBeGreaterThanOrEqual(0);
      expect(record).not.toHaveProperty("arguments");
      expect(record).not.toHaveProperty("token");
    }
  } finally { log.mockRestore(); }
});
