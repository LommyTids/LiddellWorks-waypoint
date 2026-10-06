import legacy from './worker.js';
import sync from './backend-v1/worker.js';
export default {
  async fetch(request, env, ctx) {
    // Unknown modes fail closed instead of silently returning to legacy storage.
    if (env.WAYPOINT_ENV !== 'production' && (env.WAYPOINT_ENV || env.WAYPOINT_SOURCE_HASH)) return new Response('Unsupported storage mode', {status:503});
    const url = new URL(request.url);
    if (['GET', 'HEAD'].includes(request.method) && ['/WayPoint', '/WayPoint/', '/WayPoint/app', '/WayPoint/index.html', '/waypoint', '/waypoint/app', '/waypoint/index.html'].includes(url.pathname)) {
      url.pathname = '/waypoint/';
      return Response.redirect(url.href, 308);
    }
    const lowercase = /^\/waypoint(?=\/|$)/.test(url.pathname);
    if (lowercase) {
      url.pathname = url.pathname.replace(/^\/waypoint/, '/WayPoint');
      request = new Request(url.href, request);
    }
    const response = await (env.WAYPOINT_ENV === 'production' ? sync : legacy).fetch(request, env, ctx);
    if (!lowercase) return response;
    const headers = new Headers(response.headers);
    const cookie = headers.get('Set-Cookie');
    if (cookie) headers.set('Set-Cookie', cookie.replace(/Path=\/WayPoint(?=;|$)/gi, 'Path=/waypoint'));
    const location = headers.get('Location');
    if (location) headers.set('Location', location.replace(/\/WayPoint(?=\/|\?|#|$)/g, '/waypoint'));
    // Keep the existing asset tree and older API clients, but serve canonical
    // URLs in web documents. Never rewrite JSON data or image bytes.
    const type = headers.get('Content-Type') || '';
    if (/^(text\/html|text\/css|text\/javascript|application\/javascript)\b/i.test(type) && response.body) {
      const body = (await response.text()).replace(/\/WayPoint(?=\/|["'`\s?]|$)/g, '/waypoint');
      for (const name of ['Content-Length', 'ETag', 'Content-Encoding']) headers.delete(name);
      headers.set('Cache-Control', 'no-store');
      return new Response(body, {status: response.status, statusText: response.statusText, headers});
    }
    return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
  }
};
