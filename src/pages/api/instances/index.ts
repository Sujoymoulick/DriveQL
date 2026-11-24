import type { APIRoute } from 'astro';
import { getPlatformDB } from '../../../lib/db';
import { getEnv } from '../../../lib/env';
import { decryptToken } from '../../../lib/crypto';
import { GoogleDriveClient } from '../../../lib/google-drive';
import { DriveVFS } from '../../../lib/drive-vfs';
import { PGliteEngine } from '../../../lib/pglite-engine';

export const GET: APIRoute = async ({ locals }) => {
  const db = getPlatformDB(locals);
  const user = await db.getOrCreateDefaultUser();
  const instances = await db.listInstances(user.id);

  return new Response(JSON.stringify({ instances }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = (await request.json()) as {
      name: string;
      googleAccountId: string;
      description?: string;
      allocatedQuotaGb?: number;
      initSampleData?: boolean;
    };

    if (!body.name || !body.googleAccountId) {
      return new Response(
        JSON.stringify({ error: 'name and googleAccountId are required fields' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const env = getEnv(locals);
    const db = getPlatformDB(locals);
    const user = await db.getOrCreateDefaultUser();

    // 1. Verify Google Drive account exists in user's pool
    const account = await db.getGoogleAccount(body.googleAccountId);
    if (!account) {
      return new Response(JSON.stringify({ error: 'Google Account not found in connected pool' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Resolve access token & storage
    const isMockAccount = account.encrypted_access_token === 'mock_access_token';
    const instanceId = 'dql_' + crypto.randomUUID().slice(0, 12);
    let instanceFolderId = `mock_folder_${instanceId}`;
    let manifestFileId = `mock_manifest_${instanceId}`;
    let accessToken = 'mock_token';

    if (!isMockAccount) {
      if (account.encrypted_access_token) {
        accessToken = await decryptToken(account.encrypted_access_token, env.ENCRYPTION_SECRET);
      } else if (account.encrypted_refresh_token) {
        const refreshToken = await decryptToken(account.encrypted_refresh_token, env.ENCRYPTION_SECRET);
        const refreshed = await GoogleDriveClient.refreshAccessToken(
          refreshToken,
          env.GOOGLE_CLIENT_ID,
          env.GOOGLE_CLIENT_SECRET
        );
        accessToken = refreshed.access_token;
      } else {
        throw new Error('Account lacks valid OAuth tokens. Please re-authenticate.');
      }

      // Initialize Google Drive directory structure: `_driveql_instances/db_<id>/`
      const storage = await DriveVFS.setupInstanceStorage(
        instanceId,
        body.name,
        accessToken
      );
      instanceFolderId = storage.instanceFolderId;
      manifestFileId = storage.manifestFileId;
    }

    // 4. Initialize PGlite engine and bootstrap initial Postgres tables
    const engine = new PGliteEngine();
    await engine.init();

    // Default welcome schema & sample data
    await engine.exec(`
      CREATE TABLE IF NOT EXISTS welcome (
        id SERIAL PRIMARY KEY,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO welcome (message) VALUES 
        ('Welcome to DriveQL! Your PostgreSQL database is backed by Google Drive storage.'),
        ('You have 15 GB of serverless database capacity powered by PGlite and Cloudflare Workers.');
    `);

    if (body.initSampleData) {
      await engine.exec(`
        CREATE TABLE IF NOT EXISTS products (
          id SERIAL PRIMARY KEY,
          title VARCHAR(100) NOT NULL,
          price NUMERIC(10, 2) NOT NULL,
          inventory INT DEFAULT 0
        );
        INSERT INTO products (title, price, inventory) VALUES
          ('Cloud Database Node', 0.00, 100),
          ('Edge Worker License', 0.00, 500),
          ('PostgreSQL WASM Engine', 0.00, 999);
      `);
    }

    // 5. Dump initial snapshot and upload to Google Drive
    const snapshotBlob = await engine.dumpSnapshot();
    const snapshotArrayBuffer = await snapshotBlob.arrayBuffer();
    const snapshotBytes = new Uint8Array(snapshotArrayBuffer);

    if (!isMockAccount) {
      await DriveVFS.saveBaseSnapshot(
        instanceFolderId,
        snapshotBytes,
        manifestFileId,
        accessToken
      );
    }
    await engine.close();

    // 6. Register instance in Platform DB (Cloudflare D1)
    const quotaBytes = (body.allocatedQuotaGb || 5) * 1024 * 1024 * 1024;
    const newInstance = await db.createInstance({
      id: instanceId,
      user_id: user.id,
      google_account_id: account.id,
      name: body.name,
      description: body.description || null,
      status: 'active',
      gdrive_root_folder_id: instanceFolderId,
      allocated_quota_bytes: quotaBytes,
      current_size_bytes: snapshotBytes.byteLength,
      last_snapshot_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
      pg_version: '16.2',
      is_encrypted: 0,
    });

    return new Response(
      JSON.stringify({
        success: true,
        instance: newInstance,
        message: 'PostgreSQL instance successfully created on Google Drive',
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('Instance Provisioning Error:', err);
    return new Response(JSON.stringify({ error: err.message || 'Failed to provision instance' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
