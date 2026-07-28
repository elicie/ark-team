import { createServer } from "node:http";

const host = process.env.HOST;
const port = Number(process.env.PORT);

if (
  host !== "0.0.0.0" ||
  !Number.isInteger(port) ||
  port < 10_001 ||
  port > 65_535
) {
  throw new Error("qa-smoke requires HOST=0.0.0.0 and PORT>=10001");
}

const server = createServer((request, response) => {
  if (request.headers.host !== `devbox:${port}`) {
    response.writeHead(400, { "content-type": "text/plain" });
    response.end("invalid host");
    return;
  }
  if (request.url === "/health") {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    response.end('{"status":"ok"}');
    return;
  }
  if (request.url !== "/") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(`<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Ark Team QA Smoke</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f4f1e8;
        color: #16231d;
        font-family: Arial, sans-serif;
      }
      main {
        width: min(640px, calc(100% - 48px));
        padding: 40px;
        border: 2px solid #16231d;
        border-radius: 16px;
        background: #fffdf7;
        box-shadow: 8px 8px 0 #d4aa38;
      }
      h1 { margin: 0 0 12px; font-size: clamp(32px, 7vw, 56px); }
      p { margin: 0; font-size: 18px; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>QA Smoke</h1>
      <p>Backend와 UI 검증 런타임이 같은 로컬 서버를 확인합니다.</p>
    </main>
  </body>
</html>`);
});

server.listen(port, host);
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
