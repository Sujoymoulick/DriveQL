/**
 * Platform Metadata Repository
 * Backed by Cloudflare D1 in production, with an automatic in-memory fallback for offline/local development.
 */

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
}

export interface GoogleAccount {
  id: string;
  user_id: string;
  google_email: string;
  google_account_id: string;
  encrypted_refresh_token: string;
  encrypted_access_token: string | null;
  token_expires_at: number | null;
  total_space_bytes: number;
  used_space_bytes: number;
  created_at: string;
}

export interface DatabaseInstance {
  id: string;
  user_id: string;
  google_account_id: string;
  name: string;
  description: string | null;
  status: 'provisioning' | 'active' | 'hibernated' | 'error';
  gdrive_root_folder_id: string;
  allocated_quota_bytes: number;
  current_size_bytes: number;
  last_snapshot_at: string | null;
  last_synced_at: string | null;
  pg_version: string;
  is_encrypted: number;
  created_at: string;
}

export interface ApiKey {
  id: string;
  user_id: string;
  instance_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  role?: string;
  last_used_at: string | null;
  created_at: string;
}

// In-Memory fallback store for local dev when D1 is not bound
class LocalMemoryStore {
  users: Map<string, User> = new Map();
  accounts: Map<string, GoogleAccount> = new Map();
  instances: Map<string, DatabaseInstance> = new Map();
  apiKeys: Map<string, ApiKey> = new Map();

  constructor() {
    // Seed default demo user for frictionless local dev
    this.users.set('usr_default', {
      id: 'usr_default',
      email: 'developer@driveql.local',
      display_name: 'DriveQL Developer',
      created_at: new Date().toISOString(),
    });

    // Seed test Google Drive Account 1 (15 GB)
    this.accounts.set('gacc_test1', {
      id: 'gacc_test1',
      user_id: 'usr_default',
      google_email: 'test.developer@gmail.com',
      google_account_id: 'google_test_101',
      encrypted_refresh_token: 'mock_refresh_token',
      encrypted_access_token: 'mock_access_token',
      token_expires_at: Date.now() + 3600000 * 24 * 30,
      total_space_bytes: 16106127360, // 15 GB
      used_space_bytes: 2348810240,   // 2.18 GB used
      created_at: new Date().toISOString(),
    });

    // Seed test Google Drive Account 2 (15 GB)
    this.accounts.set('gacc_test2', {
      id: 'gacc_test2',
      user_id: 'usr_default',
      google_email: 'analytics.team@gmail.com',
      google_account_id: 'google_test_102',
      encrypted_refresh_token: 'mock_refresh_token',
      encrypted_access_token: 'mock_access_token',
      token_expires_at: Date.now() + 3600000 * 24 * 30,
      total_space_bytes: 16106127360, // 15 GB
      used_space_bytes: 1073741824,   // 1.0 GB used
      created_at: new Date().toISOString(),
    });

    // Seed demo database instance (Ready to query immediately in Web Studio)
    this.instances.set('dql_demo_db', {
      id: 'dql_demo_db',
      user_id: 'usr_default',
      google_account_id: 'gacc_test1',
      name: 'ecommerce_prod',
      description: 'Production PostgreSQL Database backed by test.developer@gmail.com',
      status: 'active',
      gdrive_root_folder_id: 'gdrive_folder_mock_777',
      allocated_quota_bytes: 5368709120, // 5 GB
      current_size_bytes: 48318, // ~47 KB
      last_snapshot_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
      pg_version: '16.2',
      is_encrypted: 0,
      created_at: new Date().toISOString(),
    });
  }
}

const localStore = new LocalMemoryStore();

export class PlatformDB {
  private d1: any | null = null;
  private static tablesInitialized = false;

  constructor(d1Binding?: any) {
    this.d1 = d1Binding || null;
  }

  private async ensureTables(): Promise<void> {
    if (!this.d1 || PlatformDB.tablesInitialized) return;

    try {
      await this.d1.prepare('SELECT 1 FROM users LIMIT 1').first();
      PlatformDB.tablesInitialized = true;
    } catch {
      // Auto-migrate tables into local D1 SQLite database individually
      const schemaStatements = [
        `CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          display_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS google_accounts (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          google_email TEXT NOT NULL,
          google_account_id TEXT NOT NULL,
          encrypted_refresh_token TEXT NOT NULL,
          encrypted_access_token TEXT,
          token_expires_at INTEGER,
          total_space_bytes INTEGER DEFAULT 16106127360,
          used_space_bytes INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS database_instances (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          google_account_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          status TEXT DEFAULT 'active',
          gdrive_root_folder_id TEXT NOT NULL,
          allocated_quota_bytes INTEGER DEFAULT 5368709120,
          current_size_bytes INTEGER DEFAULT 0,
          last_snapshot_at DATETIME,
          last_synced_at DATETIME,
          pg_version TEXT DEFAULT '16.2',
          is_encrypted BOOLEAN DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          name TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          key_prefix TEXT NOT NULL,
          last_used_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `INSERT OR IGNORE INTO users (id, email, display_name) 
          VALUES ('usr_default', 'developer@driveql.local', 'DriveQL Developer')`,
        `INSERT OR IGNORE INTO google_accounts (id, user_id, google_email, google_account_id, encrypted_refresh_token, encrypted_access_token, token_expires_at, total_space_bytes, used_space_bytes) 
          VALUES ('gacc_test1', 'usr_default', 'test.developer@gmail.com', 'google_test_101', 'mock_refresh', 'mock_access_token', 9999999999999, 16106127360, 2348810240)`,
        `INSERT OR IGNORE INTO google_accounts (id, user_id, google_email, google_account_id, encrypted_refresh_token, encrypted_access_token, token_expires_at, total_space_bytes, used_space_bytes) 
          VALUES ('gacc_test2', 'usr_default', 'analytics.team@gmail.com', 'google_test_102', 'mock_refresh', 'mock_access_token', 9999999999999, 16106127360, 1073741824)`,
        `INSERT OR IGNORE INTO database_instances (id, user_id, google_account_id, name, description, status, gdrive_root_folder_id, allocated_quota_bytes, current_size_bytes, last_snapshot_at, last_synced_at, pg_version, is_encrypted) 
          VALUES ('dql_demo_db', 'usr_default', 'gacc_test1', 'ecommerce_prod', 'Production PostgreSQL Database backed by test.developer@gmail.com', 'active', 'gdrive_mock_folder_777', 5368709120, 48318, datetime('now'), datetime('now'), '16.2', 0)`
      ];

      for (const stmt of schemaStatements) {
        await this.d1.prepare(stmt).run();
      }
      PlatformDB.tablesInitialized = true;
    }
  }

  // --- Users ---
  async getOrCreateDefaultUser(): Promise<User> {
    await this.ensureTables();
    if (this.d1) {
      const existing = await this.d1.prepare('SELECT * FROM users LIMIT 1').first();
      if (existing) return existing as User;

      const newUser: User = {
        id: 'usr_' + crypto.randomUUID().slice(0, 8),
        email: 'developer@driveql.local',
        display_name: 'DriveQL Admin',
        created_at: new Date().toISOString(),
      };
      await this.d1
        .prepare('INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)')
        .bind(newUser.id, newUser.email, newUser.display_name)
        .run();
      return newUser;
    }

    return Array.from(localStore.users.values())[0];
  }

  // --- Google Accounts ---
  async listGoogleAccounts(userId: string): Promise<GoogleAccount[]> {
    await this.ensureTables();
    if (this.d1) {
      const { results } = await this.d1
        .prepare('SELECT * FROM google_accounts WHERE user_id = ? ORDER BY created_at DESC')
        .bind(userId)
        .all();
      return results as GoogleAccount[];
    }

    return Array.from(localStore.accounts.values()).filter((a) => a.user_id === userId);
  }

  async getGoogleAccount(id: string): Promise<GoogleAccount | null> {
    if (this.d1) {
      return (await this.d1
        .prepare('SELECT * FROM google_accounts WHERE id = ?')
        .bind(id)
        .first()) as GoogleAccount | null;
    }

    return localStore.accounts.get(id) || null;
  }

  async upsertGoogleAccount(account: Omit<GoogleAccount, 'created_at'>): Promise<GoogleAccount> {
    const fullAccount: GoogleAccount = {
      ...account,
      created_at: new Date().toISOString(),
    };

    if (this.d1) {
      await this.d1
        .prepare(
          `INSERT INTO google_accounts (
            id, user_id, google_email, google_account_id, encrypted_refresh_token, 
            encrypted_access_token, token_expires_at, total_space_bytes, used_space_bytes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, google_email) DO UPDATE SET
            encrypted_refresh_token = excluded.encrypted_refresh_token,
            encrypted_access_token = excluded.encrypted_access_token,
            token_expires_at = excluded.token_expires_at,
            total_space_bytes = excluded.total_space_bytes,
            used_space_bytes = excluded.used_space_bytes`
        )
        .bind(
          fullAccount.id,
          fullAccount.user_id,
          fullAccount.google_email,
          fullAccount.google_account_id,
          fullAccount.encrypted_refresh_token,
          fullAccount.encrypted_access_token,
          fullAccount.token_expires_at,
          fullAccount.total_space_bytes,
          fullAccount.used_space_bytes
        )
        .run();
      return fullAccount;
    }

    localStore.accounts.set(fullAccount.id, fullAccount);
    return fullAccount;
  }

  async deleteGoogleAccount(id: string): Promise<void> {
    if (this.d1) {
      await this.d1.prepare('DELETE FROM google_accounts WHERE id = ?').bind(id).run();
      return;
    }
    localStore.accounts.delete(id);
  }

  // --- Database Instances ---
  async listInstances(userId: string): Promise<DatabaseInstance[]> {
    await this.ensureTables();
    if (this.d1) {
      const { results } = await this.d1
        .prepare('SELECT * FROM database_instances WHERE user_id = ? ORDER BY created_at DESC')
        .bind(userId)
        .all();
      return results as DatabaseInstance[];
    }

    return Array.from(localStore.instances.values()).filter((i) => i.user_id === userId);
  }

  async getInstance(id: string): Promise<DatabaseInstance | null> {
    if (this.d1) {
      return (await this.d1
        .prepare('SELECT * FROM database_instances WHERE id = ?')
        .bind(id)
        .first()) as DatabaseInstance | null;
    }

    return localStore.instances.get(id) || null;
  }

  async createInstance(instance: Omit<DatabaseInstance, 'created_at'>): Promise<DatabaseInstance> {
    const full: DatabaseInstance = {
      ...instance,
      created_at: new Date().toISOString(),
    };

    if (this.d1) {
      await this.d1
        .prepare(
          `INSERT INTO database_instances (
            id, user_id, google_account_id, name, description, status,
            gdrive_root_folder_id, allocated_quota_bytes, current_size_bytes,
            last_snapshot_at, last_synced_at, pg_version, is_encrypted
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          full.id,
          full.user_id,
          full.google_account_id,
          full.name,
          full.description,
          full.status,
          full.gdrive_root_folder_id,
          full.allocated_quota_bytes,
          full.current_size_bytes,
          full.last_snapshot_at,
          full.last_synced_at,
          full.pg_version,
          full.is_encrypted
        )
        .run();
      return full;
    }

    localStore.instances.set(full.id, full);
    return full;
  }

  async updateInstanceStatus(
    id: string,
    updates: Partial<Pick<DatabaseInstance, 'status' | 'current_size_bytes' | 'last_synced_at' | 'last_snapshot_at'>>
  ): Promise<void> {
    if (this.d1) {
      const setClauses: string[] = [];
      const values: any[] = [];

      for (const [key, value] of Object.entries(updates)) {
        setClauses.push(`${key} = ?`);
        values.push(value);
      }
      values.push(id);

      await this.d1
        .prepare(`UPDATE database_instances SET ${setClauses.join(', ')} WHERE id = ?`)
        .bind(...values)
        .run();
      return;
    }

    const inst = localStore.instances.get(id);
    if (inst) {
      Object.assign(inst, updates);
    }
  }

  async deleteInstance(id: string): Promise<void> {
    if (this.d1) {
      await this.d1.prepare('DELETE FROM database_instances WHERE id = ?').bind(id).run();
      return;
    }
    localStore.instances.delete(id);
  }

  // --- API Keys ---
  async createApiKey(key: Omit<ApiKey, 'created_at'>): Promise<ApiKey> {
    const full: ApiKey = { ...key, created_at: new Date().toISOString() };
    if (this.d1) {
      await this.d1
        .prepare(
          'INSERT INTO api_keys (id, user_id, instance_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(full.id, full.user_id, full.instance_id, full.name, full.key_hash, full.key_prefix)
        .run();
      return full;
    }

    localStore.apiKeys.set(full.id, full);
    return full;
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
    if (this.d1) {
      return (await this.d1
        .prepare('SELECT * FROM api_keys WHERE key_hash = ?')
        .bind(keyHash)
        .first()) as ApiKey | null;
    }

    for (const k of localStore.apiKeys.values()) {
      if (k.key_hash === keyHash) return k;
    }
    return null;
  }

  async listApiKeys(instanceId: string): Promise<ApiKey[]> {
    if (this.d1) {
      const { results } = await this.d1
        .prepare('SELECT * FROM api_keys WHERE instance_id = ? ORDER BY created_at DESC')
        .bind(instanceId)
        .all();
      return results as ApiKey[];
    }

    return Array.from(localStore.apiKeys.values()).filter((k) => k.instance_id === instanceId);
  }
}

/**
 * Helper to obtain PlatformDB from Astro request locals
 */
export function getPlatformDB(locals?: any): PlatformDB {
  const d1 = locals?.runtime?.env?.DB;
  return new PlatformDB(d1);
}
