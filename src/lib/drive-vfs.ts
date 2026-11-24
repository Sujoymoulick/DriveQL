/**
 * DriveVFS: Virtual File System orchestrator over Google Drive
 * Bridges PGlite database state with Google Drive object storage.
 */

import { GoogleDriveClient } from './google-drive';
import { encryptBinary, decryptBinary } from './crypto';

export interface InstanceManifest {
  instanceId: string;
  name: string;
  version: string;
  createdAt: string;
  lastSyncedAt: string;
  currentSize: number;
  walSequence: number;
  snapshotFileId?: string;
  activeWalFileId?: string;
  tablesCount?: number;
}

export class DriveVFS {
  /**
   * Initializes the root `_driveql_instances` folder and the per-instance folder on Google Drive.
   */
  static async setupInstanceStorage(
    instanceId: string,
    instanceName: string,
    accessToken: string
  ): Promise<{ instanceFolderId: string; manifestFileId: string }> {
    // 1. Root folder for all DriveQL databases
    const rootFolderId = await GoogleDriveClient.findOrCreateFolder(
      '_driveql_instances',
      null,
      accessToken
    );

    // 2. Dedicated directory for this specific database instance
    const instanceFolderName = `db_${instanceId}`;
    const instanceFolderId = await GoogleDriveClient.findOrCreateFolder(
      instanceFolderName,
      rootFolderId,
      accessToken
    );

    // 3. Subfolder for WAL segments
    await GoogleDriveClient.findOrCreateFolder('wal', instanceFolderId, accessToken);

    // 4. Create initial manifest.json
    const manifest: InstanceManifest = {
      instanceId,
      name: instanceName,
      version: '16.2',
      createdAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
      currentSize: 0,
      walSequence: 0,
    };

    const manifestFileId = await GoogleDriveClient.uploadFile(
      'manifest.json',
      JSON.stringify(manifest, null, 2),
      'application/json',
      instanceFolderId,
      accessToken
    );

    return { instanceFolderId, manifestFileId };
  }

  /**
   * Reads the current database manifest from Google Drive.
   */
  static async getManifest(
    manifestFileId: string,
    accessToken: string
  ): Promise<InstanceManifest> {
    const buffer = await GoogleDriveClient.readFile(manifestFileId, accessToken);
    const text = new TextDecoder().decode(buffer);
    return JSON.parse(text) as InstanceManifest;
  }

  /**
   * Updates the database manifest after new transactions or checkpoints.
   */
  static async updateManifest(
    manifestFileId: string,
    manifest: InstanceManifest,
    accessToken: string
  ): Promise<void> {
    manifest.lastSyncedAt = new Date().toISOString();
    const content = JSON.stringify(manifest, null, 2);
    await GoogleDriveClient.updateFileContent(
      manifestFileId,
      content,
      'application/json',
      accessToken
    );
  }

  /**
   * Saves a full PGlite database snapshot (data directory tarball) to Google Drive.
   * Encrypts the snapshot with AES-256-GCM before upload for zero-knowledge storage.
   */
  static async saveBaseSnapshot(
    instanceFolderId: string,
    snapshotData: Uint8Array,
    manifestFileId: string,
    accessToken: string,
    encryptionKey?: string
  ): Promise<string> {
    const dataToUpload = encryptionKey
      ? await encryptBinary(snapshotData, encryptionKey)
      : snapshotData;

    const fileName = `snapshot_${Date.now()}.tar.gz.enc`;
    const fileId = await GoogleDriveClient.uploadFile(
      fileName,
      dataToUpload,
      'application/octet-stream',
      instanceFolderId,
      accessToken
    );

    // Update manifest
    const manifest = await this.getManifest(manifestFileId, accessToken);
    manifest.snapshotFileId = fileId;
    manifest.currentSize = dataToUpload.byteLength;
    await this.updateManifest(manifestFileId, manifest, accessToken);

    return fileId;
  }

  /**
   * Reads the latest base snapshot to hydrate an edge PGlite instance.
   * Decrypts AES-256-GCM encrypted snapshot data on the fly.
   */
  static async loadBaseSnapshot(
    snapshotFileId: string,
    accessToken: string,
    encryptionKey?: string
  ): Promise<ArrayBuffer> {
    const rawBuffer = await GoogleDriveClient.readFile(snapshotFileId, accessToken);
    if (encryptionKey) {
      const decrypted = await decryptBinary(new Uint8Array(rawBuffer), encryptionKey);
      return decrypted.buffer;
    }
    return rawBuffer;
  }

  /**
   * Appends an incremental WAL segment to Google Drive with AES-256-GCM encryption.
   */
  static async appendWalSegment(
    instanceFolderId: string,
    walData: Uint8Array,
    manifestFileId: string,
    accessToken: string,
    encryptionKey?: string
  ): Promise<string> {
    const walFolderId = await GoogleDriveClient.findOrCreateFolder('wal', instanceFolderId, accessToken);
    const manifest = await this.getManifest(manifestFileId, accessToken);

    const walToUpload = encryptionKey
      ? await encryptBinary(walData, encryptionKey)
      : walData;

    manifest.walSequence += 1;
    const seqStr = manifest.walSequence.toString().padStart(8, '0');
    const fileName = `${seqStr}.wal.enc`;

    const fileId = await GoogleDriveClient.uploadFile(
      fileName,
      walToUpload,
      'application/octet-stream',
      walFolderId,
      accessToken
    );

    manifest.activeWalFileId = fileId;
    manifest.currentSize += walToUpload.byteLength;
    await this.updateManifest(manifestFileId, manifest, accessToken);

    return fileId;
  }
}
