import type { APIRoute } from 'astro';
import { GoogleDriveClient } from '../../../../lib/google-drive';
import { encryptToken } from '../../../../lib/crypto';
import { getPlatformDB } from '../../../../lib/db';
import { getEnv } from '../../../../lib/env';

export const GET: APIRoute = async ({ request, locals, redirect }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    return redirect(`/dashboard/accounts?error=${encodeURIComponent(error || 'Missing authorization code')}`);
  }

  const env = getEnv(locals);
  const redirectUri = `${env.APP_URL.replace(/\/$/, '')}/api/auth/google/callback`;

  try {
    // 1. Exchange code for access & refresh tokens
    const tokens = await GoogleDriveClient.exchangeCode(
      code,
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      redirectUri
    );

    // 2. Fetch account storage quota and user profile
    const quota = await GoogleDriveClient.getStorageQuota(tokens.access_token);

    // 3. Encrypt sensitive tokens with AES-256-GCM
    const encryptedRefreshToken = tokens.refresh_token
      ? await encryptToken(tokens.refresh_token, env.ENCRYPTION_SECRET)
      : '';
    const encryptedAccessToken = await encryptToken(tokens.access_token, env.ENCRYPTION_SECRET);
    const tokenExpiresAt = Date.now() + tokens.expires_in * 1000;

    // 4. Upsert account in Platform DB (Cloudflare D1)
    const db = getPlatformDB(locals);
    const user = await db.getOrCreateDefaultUser();

    await db.upsertGoogleAccount({
      id: 'gacc_' + crypto.randomUUID().slice(0, 8),
      user_id: user.id,
      google_email: quota.userEmail,
      google_account_id: quota.userEmail,
      encrypted_refresh_token: encryptedRefreshToken,
      encrypted_access_token: encryptedAccessToken,
      token_expires_at: tokenExpiresAt,
      total_space_bytes: quota.total,
      used_space_bytes: quota.used,
    });

    return redirect('/dashboard/accounts?connected=true');
  } catch (err: any) {
    console.error('OAuth Callback Error:', err);
    return redirect(`/dashboard/accounts?error=${encodeURIComponent(err.message || 'OAuth linking failed')}`);
  }
};
