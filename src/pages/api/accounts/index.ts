import type { APIRoute } from 'astro';
import { getPlatformDB } from '../../../lib/db';

export const GET: APIRoute = async ({ locals }) => {
  const db = getPlatformDB(locals);
  const user = await db.getOrCreateDefaultUser();
  const accounts = await db.listGoogleAccounts(user.id);

  // Strip encrypted tokens from API response
  const sanitized = accounts.map((acc) => ({
    id: acc.id,
    google_email: acc.google_email,
    total_space_bytes: acc.total_space_bytes,
    used_space_bytes: acc.used_space_bytes,
    free_space_bytes: Math.max(0, acc.total_space_bytes - acc.used_space_bytes),
    created_at: acc.created_at,
  }));

  const totalPoolStorage = sanitized.reduce((sum, a) => sum + a.total_space_bytes, 0);
  const totalUsedStorage = sanitized.reduce((sum, a) => sum + a.used_space_bytes, 0);

  return new Response(
    JSON.stringify({
      accounts: sanitized,
      total_accounts: sanitized.length,
      storage_summary: {
        total_bytes: totalPoolStorage,
        used_bytes: totalUsedStorage,
        free_bytes: totalPoolStorage - totalUsedStorage,
        total_gb: Math.round((totalPoolStorage / 1024 / 1024 / 1024) * 10) / 10,
        used_gb: Math.round((totalUsedStorage / 1024 / 1024 / 1024) * 10) / 10,
      },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  try {
    const body = (await request.json()) as { accountId: string };
    if (!body.accountId) {
      return new Response(JSON.stringify({ error: 'accountId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const db = getPlatformDB(locals);
    await db.deleteGoogleAccount(body.accountId);

    return new Response(JSON.stringify({ success: true, message: 'Google Drive account unlinked' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
