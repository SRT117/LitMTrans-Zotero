import http from "node:http";
import fs from "node:fs";
import path from "node:path";

function getArg(flag, fallback = "") {
  const index = process.argv.indexOf(`--${flag}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(getArg("port", "23129"));
const manifestPath = path.resolve(getArg("manifest"));
const xpiPath = path.resolve(getArg("xpi"));

if (!fs.existsSync(manifestPath)) {
  console.error(`Update manifest not found: ${manifestPath}`);
  process.exit(1);
}
if (!fs.existsSync(xpiPath)) {
  console.error(`Update XPI not found: ${xpiPath}`);
  process.exit(1);
}

const xpiFilename = path.basename(xpiPath);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const pathname = url.pathname;

  if (pathname === "/update.json") {
    try {
      const content = fs.readFileSync(manifestPath, "utf8");
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate"
      });
      res.end(content);
      console.log(`[UpdateServer] Served update.json to ${req.socket.remoteAddress}`);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(err));
    }
    return;
  }

  if (pathname === `/${xpiFilename}` || pathname === "/litmtrans-dev-update.xpi") {
    try {
      const stat = fs.statSync(xpiPath);
      res.writeHead(200, {
        "Content-Type": "application/x-xpinstall",
        "Content-Length": stat.size,
        "Cache-Control": "no-cache, no-store, must-revalidate"
      });
      fs.createReadStream(xpiPath).pipe(res);
      console.log(`[UpdateServer] Serving XPI update (${stat.size} bytes)...`);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(err));
    }
    return;
  }

  if (pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "running", port, xpiFilename }));
    return;
  }

  if (pathname === "/shutdown") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "shutting_down" }));
    console.log("[UpdateServer] Shutdown requested via /shutdown");
    setTimeout(() => {
      server.close(() => process.exit(0));
    }, 100);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[UpdateServer] Local upgrade server listening on http://127.0.0.1:${port}`);
  console.log(`[UpdateServer] Update manifest: http://127.0.0.1:${port}/update.json`);
  console.log(`[UpdateServer] Update XPI: http://127.0.0.1:${port}/${xpiFilename}`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
