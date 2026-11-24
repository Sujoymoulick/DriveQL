-- DriveQL Cloudflare D1 Migration: 0001_initial.sql

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Connected Google Drive Accounts
CREATE TABLE IF NOT EXISTS google_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    google_email TEXT NOT NULL,
    google_account_id TEXT NOT NULL,
    encrypted_refresh_token TEXT NOT NULL,
    encrypted_access_token TEXT,
    token_expires_at INTEGER,
    total_space_bytes INTEGER DEFAULT 16106127360, -- 15 GB
    used_space_bytes INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, google_email)
);

-- 3. Database Instances
CREATE TABLE IF NOT EXISTS database_instances (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    google_account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT CHECK(status IN ('provisioning', 'active', 'hibernated', 'error')) DEFAULT 'active',
    gdrive_root_folder_id TEXT NOT NULL,
    allocated_quota_bytes INTEGER DEFAULT 5368709120, -- 5 GB default
    current_size_bytes INTEGER DEFAULT 0,
    last_snapshot_at DATETIME,
    last_synced_at DATETIME,
    pg_version TEXT DEFAULT '16.2',
    is_encrypted BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(google_account_id) REFERENCES google_accounts(id) ON DELETE RESTRICT
);

-- 4. API Keys for External Programmatic Access
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    last_used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(instance_id) REFERENCES database_instances(id) ON DELETE CASCADE
);

-- 5. WAL Checkpoints & Audit Log
CREATE TABLE IF NOT EXISTS wal_checkpoints (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    sequence_number INTEGER NOT NULL,
    file_id TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(instance_id) REFERENCES database_instances(id) ON DELETE CASCADE
);

-- Indexes for lightning fast lookups
CREATE INDEX IF NOT EXISTS idx_google_accounts_user ON google_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_instances_user ON database_instances(user_id);
CREATE INDEX IF NOT EXISTS idx_instances_account ON database_instances(google_account_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_wal_checkpoints_inst ON wal_checkpoints(instance_id);
