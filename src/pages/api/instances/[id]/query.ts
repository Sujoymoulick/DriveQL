import type { APIRoute } from 'astro';
import { getPlatformDB } from '../../../../lib/db';
import { hashApiKey } from '../../../../lib/crypto';
import { getOrInitEngine } from '../../../../lib/pglite-engine';

export const POST: APIRoute = async ({ params, request, locals }) => {
  const instanceId = params.id;
  if (!instanceId) {
    return new Response(JSON.stringify({ error: 'Missing instance ID' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const db = getPlatformDB(locals);
  const authHeader = request.headers.get('Authorization');
  let keyRecord: any = null;

  // Verify API Key if present
  if (authHeader && authHeader.startsWith('Bearer dql_')) {
    const rawKey = authHeader.replace('Bearer ', '').trim();
    const keyHash = await hashApiKey(rawKey);
    keyRecord = await db.getApiKeyByHash(keyHash);

    if (!keyRecord || keyRecord.instance_id !== instanceId) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Invalid API Key for this instance' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  try {
    const body = (await request.json()) as {
      query: string;
      params?: any[];
      rlsContext?: {
        userId?: string;
        role?: 'anon' | 'authenticated' | 'admin';
      };
    };

    if (!body.query) {
      return new Response(JSON.stringify({ error: 'query parameter is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Security: Payload size validation
    if (body.query.length > 200000) {
      return new Response(JSON.stringify({ error: 'Payload Too Large: Query exceeds 200KB limit.' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const trimmedQuery = body.query.trim().toUpperCase();

    // Security: Enforce Read-Only restrictions if key has read-only scope
    const isReadOnlyKey =
      keyRecord &&
      ((keyRecord as any).role === 'read-only' ||
        (keyRecord as any).key_prefix?.includes('(read-only)'));

    if (isReadOnlyKey) {
      const mutationKeywords = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE'];
      const isMutation = mutationKeywords.some(kw => 
        trimmedQuery.startsWith(kw) || 
        trimmedQuery.includes(`\n${kw} `) || 
        trimmedQuery.includes(`; ${kw} `) ||
        trimmedQuery.includes(`;${kw} `)
      );
      if (isMutation) {
        return new Response(JSON.stringify({
          error: 'Permission Denied: Read-Only API Key cannot execute mutations or DDL statements.',
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
    }

    const instance = await db.getInstance(instanceId);
    if (!instance) {
      return new Response(JSON.stringify({ error: 'Database instance not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Extract RLS Context from body or custom request headers
    const rlsUserId =
      body.rlsContext?.userId ||
      request.headers.get('X-User-Id') ||
      'admin_root';

    const rlsRole =
      body.rlsContext?.role ||
      (request.headers.get('X-User-Role') as any) ||
      'admin';

    // Get or initialize cached PGlite engine for this instance
    const engine = await getOrInitEngine(instanceId);

    // Execute query with native RLS session context and role simulation
    const result = await engine.executeInContext({
      query: body.query,
      params: body.params,
      rlsContext: {
        userId: rlsUserId,
        role: rlsRole,
      },
    });

    // Update instance last active time
    await db.updateInstanceStatus(instanceId, {
      last_synced_at: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify({
        rows: result.rows,
        fields: result.fields,
        rowCount: result.rowCount,
        durationMs: result.durationMs,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: err.message || 'SQL execution failed',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
