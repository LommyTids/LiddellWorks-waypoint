// A tiny stand-in for the real Cloudflare Worker, used only to test the
// adapted frontend locally before it's deployed for real. It serves the
// static app at /WayPoint and implements the same GET/POST JSON API the
// real Worker will (backed by an in-memory variable instead of KV).
const http = require('http');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'public/WayPoint/index.html'), 'utf-8');
let stored = '{"trips":[]}';

const server = http.createServer((req, res) => {
  if (req.url === '/WayPoint/api/data' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(stored);
    return;
  }
  if (req.url === '/WayPoint/api/data' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      stored = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
    });
    return;
  }
  if (req.url === '/WayPoint' || req.url === '/WayPoint/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

const port = process.argv[2] || 8787;
server.listen(port, () => console.log('mock server listening on ' + port));
