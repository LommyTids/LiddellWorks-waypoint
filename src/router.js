import legacy from './worker.js';
import sync from './backend-v1/worker.js';
export default {
  fetch(request, env, ctx) {
    if (env.WAYPOINT_ENV === 'production') return sync.fetch(request, env, ctx);
    // Unknown modes fail closed instead of silently returning to legacy storage.
    if (env.WAYPOINT_ENV || env.WAYPOINT_SOURCE_HASH) return new Response('Unsupported storage mode', {status:503});
    return legacy.fetch(request, env, ctx);
  }
};
