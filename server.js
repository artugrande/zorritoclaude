const http = require("http");
const fs   = require("fs");
const path = require("path");

const PORT = 3456;
const ROOT = path.join(__dirname, "frontend");

const MIME = {
  ".html": "text/html",
  ".css":  "text/css",
  ".js":   "application/javascript",
};

http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  const filePath = path.join(ROOT, pathname === "/" ? "index.html" : pathname);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Zorrito running on http://localhost:${PORT}`));
