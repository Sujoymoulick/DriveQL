import type { APIRoute } from 'astro';
import { getPlatformDB } from '../../../lib/db';

export const POST: APIRoute = async ({ request, locals }) => {
  const db = getPlatformDB(locals);
  const user = await db.getOrCreateDefaultUser();

  const idSuffix = Math.floor(100 + Math.random() * 900);
  const newEmail = `dev.storage${idSuffix}@gmail.com`;

  const newAcc = await db.upsertGoogleAccount({
    id: `gacc_test_${idSuffix}`,
    user_id: user.id,
    google_email: newEmail,
    google_account_id: `google_mock_${idSuffix}`,
    encrypted_refresh_token: 'mock_refresh_token',
    encrypted_access_token: 'mock_access_token',
    token_expires_at: Date.now() + 3600000 * 24 * 30,
    total_space_bytes: 16106127360, // 15 GB
    used_space_bytes: Math.floor(Math.random() * 3000000000), // ~1-3 GB used
  });

  return new Response(
    JSON.stringify({
      success: true,
      account: newAcc,
      message: `Test Drive Account ${newEmail} connected! +15 GB added to pool.`,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
};
