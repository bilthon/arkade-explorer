import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { listBatches, getBatch, stats } from "./db.js";
import { ARK_URL } from "./arkade.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 8080);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function json(res, body, code = 200) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (path === "/api/stats") return json(res, { ...stats(), operator: ARK_URL });
    if (path === "/api/batches") return json(res, listBatches(Number(url.searchParams.get("limit")) || 100));
    if (path.startsWith("/api/batch/")) {
      const row = getBatch(path.slice("/api/batch/".length));
      if (!row) return json(res, { error: "not found" }, 404);
      return json(res, {
        ...row,
        commitment_json: JSON.parse(row.commitment_json || "{}"),
        tree_json: JSON.parse(row.tree_json || "[]"),
        leaves_json: JSON.parse(row.leaves_json || "[]"),
      });
    }

    // static
    const file = path === "/" ? "/index.html" : path;
    const data = await readFile(join(PUBLIC, file));
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }
});

server.listen(PORT, () => console.log(`explorer on http://localhost:${PORT}  (operator ${ARK_URL})`));
