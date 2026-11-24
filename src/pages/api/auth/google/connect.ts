import type { APIRoute } from 'astro';
import { GoogleDriveClient } from '../../../../lib/google-drive';
import { getEnv } from '../../../../lib/env';

export const GET: APIRoute = async ({ locals, url, redirect }) => {
  const env = getEnv(locals);

  if (!env.GOOGLE_CLIENT_ID) {
    return new Response(
      JSON.stringify({
        error: 'GOOGLE_CLIENT_ID is not configured. Please set it in your .env or Cloudflare environment.',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const redirectUri = `${env.APP_URL.replace(/\/$/, '')}/api/auth/google/callback`;
  const state = crypto.randomUUID();

  const authUrl = GoogleDriveClient.getAuthUrl(env.GOOGLE_CLIENT_ID, redirectUri, state);

  return redirect(authUrl);
};
