/**
 * Google Drive REST API v3 Client
 * Optimized for serverless edge and Cloudflare Workers.
 * Features:
 * - OAuth2 Token Flow & Refresh
 * - HTTP Range Downloads (Surgical block/chunk reads)
 * - Multipart / Resumable File Uploads
 * - Storage Quota & User Profile Telemetry
 */

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export interface DriveQuota {
  total: number;
  used: number;
  userEmail: string;
  userName: string;
}

export class GoogleDriveClient {
  /**
   * Generates the OAuth2 Authorization Consent URL.
   * Scopes requested:
   * - `https://www.googleapis.com/auth/drive.file` (Only access files created by DriveQL - safe, non-sensitive)
   * - `https://www.googleapis.com/auth/userinfo.email`
   * - `https://www.googleapis.com/auth/userinfo.profile`
   */
  static getAuthUrl(clientId: string, redirectUri: string, state: string): string {
    const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ].join(' '),
      access_type: 'offline', // Demands refresh_token
      prompt: 'consent',     // Ensures refresh_token is always returned
      state: state,
    });

    return `${rootUrl}?${params.toString()}`;
  }

  /**
   * Exchanges authorization code for access and refresh tokens.
   */
  static async exchangeCode(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string
  ): Promise<GoogleTokens> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Google OAuth code exchange failed: ${err}`);
    }

    return (await response.json()) as GoogleTokens;
  }

  /**
   * Refreshes an expired access token using the encrypted refresh token.
   */
  static async refreshAccessToken(
    refreshToken: string,
    clientId: string,
    clientSecret: string
  ): Promise<{ access_token: string; expires_in: number }> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Google OAuth token refresh failed: ${err}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    return data;
  }

  /**
   * Fetches Google Drive storage quota (Limit: usually 15 GB free) and user details.
   */
  static async getStorageQuota(accessToken: string): Promise<DriveQuota> {
    const response = await fetch(
      'https://www.googleapis.com/drive/v3/about?fields=storageQuota,user',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch Drive quota: ${await response.text()}`);
    }

    const data = (await response.json()) as any;
    const total = parseInt(data.storageQuota?.limit || '16106127360', 10); // 15 GB default
    const used = parseInt(data.storageQuota?.usage || '0', 10);
    const userEmail = data.user?.emailAddress || 'unknown@gmail.com';
    const userName = data.user?.displayName || 'Google User';

    return { total, used, userEmail, userName };
  }

  /**
   * Creates or locates a directory in Google Drive.
   */
  static async findOrCreateFolder(
    folderName: string,
    parentFolderId: string | null,
    accessToken: string
  ): Promise<string> {
    // 1. Search for existing folder
    let query = `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    if (parentFolderId) {
      query += ` and '${parentFolderId}' in parents`;
    }

    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`;
    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (searchRes.ok) {
      const searchData = (await searchRes.json()) as any;
      if (searchData.files && searchData.files.length > 0) {
        return searchData.files[0].id;
      }
    }

    // 2. Create new folder if not found
    const meta: Record<string, any> = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
    };
    if (parentFolderId) {
      meta.parents = [parentFolderId];
    }

    const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(meta),
    });

    if (!createRes.ok) {
      throw new Error(`Failed to create folder ${folderName}: ${await createRes.text()}`);
    }

    const createData = (await createRes.json()) as any;
    return createData.id;
  }

  /**
   * Uploads or updates a file using multipart upload.
   */
  static async uploadFile(
    fileName: string,
    content: string | Uint8Array,
    mimeType: string,
    parentFolderId: string,
    accessToken: string
  ): Promise<string> {
    const metadata = {
      name: fileName,
      parents: [parentFolderId],
      mimeType: mimeType,
    };

    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const binaryData = typeof content === 'string' ? new TextEncoder().encode(content) : content;

    const multipartHeader = `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
      metadata
    )}${delimiter}Content-Type: ${mimeType}\r\nContent-Transfer-Encoding: binary\r\n\r\n`;

    const headerBytes = new TextEncoder().encode(multipartHeader);
    const footerBytes = new TextEncoder().encode(closeDelimiter);

    const fullPayload = new Uint8Array(headerBytes.length + binaryData.length + footerBytes.length);
    fullPayload.set(headerBytes, 0);
    fullPayload.set(binaryData, headerBytes.length);
    fullPayload.set(footerBytes, headerBytes.length + binaryData.length);

    const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size';
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: fullPayload,
    });

    if (!res.ok) {
      throw new Error(`Failed to upload file ${fileName}: ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    return data.id;
  }

  /**
   * Reads a file completely or reads surgical byte ranges via HTTP Range header.
   * Enables surgical 64KB block reads from large DB snapshots!
   */
  static async readFile(
    fileId: string,
    accessToken: string,
    byteRange?: { start: number; end: number }
  ): Promise<ArrayBuffer> {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    };

    if (byteRange) {
      headers['Range'] = `bytes=${byteRange.start}-${byteRange.end}`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok && res.status !== 206) {
      throw new Error(`Failed to read file ${fileId}: ${await res.text()}`);
    }

    return await res.arrayBuffer();
  }

  /**
   * Updates existing file content in-place.
   */
  static async updateFileContent(
    fileId: string,
    content: string | Uint8Array,
    mimeType: string,
    accessToken: string
  ): Promise<void> {
    const url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': mimeType,
      },
      body: content,
    });

    if (!res.ok) {
      throw new Error(`Failed to update file ${fileId}: ${await res.text()}`);
    }
  }

  /**
   * Deletes a file or directory recursively from Google Drive.
   */
  static async deleteFile(fileId: string, accessToken: string): Promise<void> {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete file ${fileId}: ${await res.text()}`);
    }
  }
}
