import path from "node:path";

type Options = {
  directory: string;
  hostname: string;
  port: number;
};

const getOption = (args: string[], name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const parseOptions = (): Options => {
  const args = process.argv.slice(2);
  const port = Number(getOption(args, "--port", "5001"));

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  return {
    directory: path.resolve(getOption(args, "--dir", "build")),
    hostname: getOption(args, "--host", "localhost"),
    port,
  };
};

const isInsideDirectory = (directory: string, candidate: string) => {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

const getFilePath = (directory: string, pathname: string) => {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decodedPath.includes("\0")) {
    return null;
  }

  const normalizedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const candidate = path.resolve(directory, `.${normalizedPath}`);
  return isInsideDirectory(directory, candidate) ? candidate : null;
};

const serveFile = async (filePath: string) => {
  const file = Bun.file(filePath);
  return (await file.exists()) ? file : null;
};

const createHandler = (directory: string) => async (request: Request) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const url = new URL(request.url);
  const filePath = getFilePath(directory, url.pathname);
  if (!filePath) {
    return new Response("Bad Request", { status: 400 });
  }

  const requestedFile = await serveFile(filePath);
  const acceptsHtml = request.headers.get("accept")?.includes("text/html");
  const fallbackPath = path.join(directory, "index.html");
  const file =
    requestedFile ||
    (acceptsHtml ? await serveFile(fallbackPath) : null);

  if (!file) {
    return new Response("Not Found", { status: 404 });
  }

  return new Response(file, {
    headers: {
      "Cache-Control": (requestedFile ? filePath : fallbackPath).endsWith("index.html")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    },
  });
};

const options = parseOptions();
const server = Bun.serve({
  hostname: options.hostname,
  port: options.port,
  fetch: createHandler(options.directory),
});

console.info(
  `[Static] Serving ${options.directory} at http://${options.hostname}:${server.port}`,
);
