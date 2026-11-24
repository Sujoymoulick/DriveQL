import type { APIRoute } from 'astro';
import { getPlatformDB } from '../../../../lib/db';
import { getRuntimeEnv } from '../../../../lib/env';
import { decryptToken } from '../../../../lib/crypto';
import { GoogleDriveClient } from '../../../../lib/google-drive';
import { DriveVFS } from '../../../../lib/drive-vfs';
import { getOrInitEngine } from '../../../../lib/pglite-engine';

export const POST: APIRoute = async ({ params, locals }) => {
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

  const account = await db.getGoogleAccount(instance.google_account_id);
  if (!account) {
    return new Response(JSON.stringify({ error: 'Associated Google Drive account not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const isMockAccount = account.encrypted_refresh_token.startsWith('mock_');

  try {
    const env = getRuntimeEnv(locals);
    let accessToken = '';

    if (!isMockAccount) {
      if (account.token_expires_at > Date.now() + 60000) {
        accessToken = await decryptToken(account.encrypted_access_token, env.ENCRYPTION_SECRET);
      } else {
        const refreshToken = await decryptToken(account.encrypted_refresh_token, env.ENCRYPTION_SECRET);
        const res = await GoogleDriveClient.refreshAccessToken(
          refreshToken,
          env.GOOGLE_CLIENT_ID,
          env.GOOGLE_CLIENT_SECRET
        );
        accessToken = res.access_token;
      }
    }

    // 2. Fetch live engine and dump fresh snapshot
    const engine = await getOrInitEngine(instanceId);
    const snapshotBlob = await engine.dumpSnapshot();
    const snapshotBytes = new Uint8Array(await snapshotBlob.arrayBuffer());

    let snapshotFileId = 'mock_snapshot_id';

    if (!isMockAccount && accessToken) {
      const manifestFileId = instance.gdrive_root_folder_id;
      snapshotFileId = await DriveVFS.saveBaseSnapshot(
        instance.gdrive_root_folder_id,
        snapshotBytes,
        manifestFileId,
        accessToken,
        env.ENCRYPTION_SECRET
      ).catch(async () => {
        return await GoogleDriveClient.uploadFile(
          `snapshot_${Date.now()}.tar.gz`,
          snapshotBytes,
          'application/gzip',
          instance.gdrive_root_folder_id,
          accessToken
        );
      });
    }

    // 4. Update instance status
    const now = new Date().toISOString();
    await db.updateInstanceStatus(instanceId, {
      current_size_bytes: snapshotBytes.byteLength,
      last_snapshot_at: now,
      last_synced_at: now,
    });

    // Record checkpoint in D1
    await db.recordWalCheckpoint({
      id: 'chk_' + crypto.randomUUID().slice(0, 8),
      instance_id: instanceId,
      wal_file_id: snapshotFileId,
      wal_size_bytes: snapshotBytes.byteLength,
      created_at: now,
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Google Drive snapshot checkpoint saved successfully.',
        snapshotSizeBytes: snapshotBytes.byteLength,
        timestamp: now,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: err.message || 'Snapshot sync failed',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
