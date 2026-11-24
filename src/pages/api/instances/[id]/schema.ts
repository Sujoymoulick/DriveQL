import type { APIRoute } from 'astro';
import { getPlatformDB } from '../../../../lib/db';
import { getOrInitEngine } from '../../../../lib/pglite-engine';

export const GET: APIRoute = async ({ params, locals }) => {
  const instanceId = params.id;
  if (!instanceId) {
    return new Response(JSON.stringify({ error: 'Missing instance ID' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const db = getPlatformDB(locals);
  const instance = await db.getInstance(instanceId);
  if (!instance) {
    return new Response(JSON.stringify({ error: 'Instance not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const engine = await getOrInitEngine(instanceId);
    const tables = await engine.inspectSchema();

    return new Response(
      JSON.stringify({
        instanceId,
        tables,
        totalTables: tables.length,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
