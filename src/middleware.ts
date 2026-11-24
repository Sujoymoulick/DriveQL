import { defineMiddleware } from 'astro:middleware';

// In-memory sliding window rate limiter for edge protection
const ipRequestCounts = new Map<string, { count: number; resetAt: number }>();

export const onRequest = defineMiddleware(async (context, next) => {
  const ip =
    context.request.headers.get('cf-connecting-ip') ||
    context.request.headers.get('x-forwarded-for') ||
    '127.0.0.1';
  const pathname = new URL(context.request.url).pathname;

  // 0. Handle CORS preflight OPTIONS requests
  if (context.request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id, X-User-Role',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // 1. Rate Limiting on API endpoints: 180 requests per minute per client IP
  if (pathname.startsWith('/api/')) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const limit = 180;

    let record = ipRequestCounts.get(ip);
    if (!record || now > record.resetAt) {
      record = { count: 1, resetAt: now + windowMs };
    } else {
      record.count += 1;
    }
    ipRequestCounts.set(ip, record);

    if (record.count > limit) {
      const retryAfter = Math.ceil((record.resetAt - now) / 1000);
      return new Response(
        JSON.stringify({
          error: 'Rate Limit Exceeded: Max 180 requests per minute allowed on edge database endpoints.',
          retryAfterSeconds: retryAfter,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfter),
          },
        }
      );
    }
  }

  // 2. Forward execution
  const response = await next();

  // 3. Attach Defense-in-Depth Security Headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Prevent CORS wildcards on authenticated API routes
  if (pathname.startsWith('/api/')) {
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Id, X-User-Role');
  }

  return response;
});
