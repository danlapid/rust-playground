import { compileAndRun, type PlaygroundRequest } from './pipeline';

export { Cached } from './cache';

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (e) {
      // The page shows this; otherwise it would get Cloudflare's error page.
      console.error(e);
      return new Response(e instanceof Error ? `${e.name}: ${e.message}` : String(e), { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname === '/api/run') {
    const body = (await request.json()) as PlaygroundRequest;
    if (typeof body.code !== 'string') return new Response('expected {"code": "..."}', { status: 400 });
    if (!request.headers.get('accept')?.includes('application/x-ndjson')) return Response.json(await compileAndRun(env, body));
    // The run as it happens: one JSON event per line (src/events.ts), `t` milliseconds in,
    // then {"type": "result"} with what the JSON response would have been.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const t0 = performance.now();
    const send = (event: object) => writer.write(enc.encode(`${JSON.stringify({ t: performance.now() - t0, ...event })}\n`)).catch(() => {});
    (async () => {
      try {
        send({ type: 'result', result: await compileAndRun(env, body, send) });
      } catch (e) {
        console.error(e);
        send({ type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
      } finally {
        await writer.close().catch(() => {});
      }
    })();
    return new Response(readable, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
  }
  return new Response('not found', { status: 404 });
}
