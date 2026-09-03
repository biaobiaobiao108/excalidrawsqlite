const subscribers = new Set<WritableStreamDefaultWriter>();

export const handleDevReloadRequest = (req: Request): Response => {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  subscribers.add(writer);

  req.signal.addEventListener("abort", () => {
    subscribers.delete(writer);
    try {
      writer.close();
    } catch {}
  });

  // Initial handshake message
  writer.write(new TextEncoder().encode("retry: 1500\ndata: connected\n\n")).catch(() => {});

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
};

export const broadcastDevReload = () => {
  if (subscribers.size === 0) return;
  const msg = new TextEncoder().encode("data: reload\n\n");
  for (const writer of Array.from(subscribers)) {
    writer.write(msg).catch(() => {
      subscribers.delete(writer);
    });
  }
};
