import type { APIRoute } from 'astro';
import { getPlatformDB } from '../../../../lib/db';
import { hashApiKey } from '../../../../lib/crypto';

export const GET: APIRoute = async ({ params, locals }) => {
  const instanceId = params.id;
  if (!instanceId) {
    return new Response(JSON.stringify({ error: 'Missing instance ID' }), { status: 400 });
  }

  const db = getPlatformDB(locals);
  const keys = await db.listApiKeys(instanceId);

  return new Response(
    JSON.stringify({
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.key_prefix,
        last_used_at: k.last_used_at,
        created_at: k.created_at,
      })),
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const instanceId = params.id;
  if (!instanceId) {
    return new Response(JSON.stringify({ error: 'Missing instance ID' }), { status: 400 });
  }

  const db = getPlatformDB(locals);
  const user = await db.getOrCreateDefaultUser();

  try {
    const body = (await request.json()) as { name?: string; role?: 'admin' | 'read-only' };
    const keyName = body.name || 'Default API Key';
    const keyRole = body.role === 'read-only' ? 'read-only' : 'admin';

    // Generate secret key format: dql_live_<role>_<32 random hex chars>
    const randomBytes = crypto.getRandomValues(new Uint8Array(16));
    const randomHex = Array.from(randomBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const rawApiKey = `dql_live_${randomHex}`;
    const keyPrefix = `${rawApiKey.slice(0, 12)}... (${keyRole})`;
    const keyHash = await hashApiKey(rawApiKey);

    const keyRecord = await db.createApiKey({
      id: 'key_' + crypto.randomUUID().slice(0, 8),
      user_id: user.id,
      instance_id: instanceId,
      name: `${keyName} [${keyRole.toUpperCase()}]`,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      last_used_at: null,
    });

    return new Response(
      JSON.stringify({
        success: true,
        apiKey: rawApiKey, // Only revealed once!
        keyId: keyRecord.id,
        name: keyRecord.name,
        prefix: keyRecord.key_prefix,
        message: 'Save this API key safely. You will not be able to view it again.',
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
