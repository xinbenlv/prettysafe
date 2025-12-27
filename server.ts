// Simple Bun Server
const server = Bun.serve({
  port: 5173,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response(Bun.file("web/index.html"));
    if (url.pathname === "/keccak.wgsl") return new Response(Bun.file("keccak.wgsl"));
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Listening on http://localhost:${server.port} ...`);

