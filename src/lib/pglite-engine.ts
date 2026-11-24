/**
 * Serverless PGlite (Postgres WASM) Execution Engine
 * Evaluates standard PostgreSQL queries with sub-millisecond execution,
 * native Row-Level Security (RLS) simulation, and multi-tenant isolation.
 */

import { PGlite } from '@electric-sql/pglite';

export interface QueryResult {
  rows: any[];
  fields: { name: string; dataTypeID: number }[];
  rowCount: number;
  durationMs: number;
}

export interface TableColumn {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

export interface TableSummary {
  tableName: string;
  columns: TableColumn[];
  rowCount: number;
  rlsEnabled?: boolean;
}

export interface RlsPolicy {
  schemaname: string;
  tablename: string;
  policyname: string;
  roles: string[];
  cmd: string;
  using_clause: string | null;
  with_check_clause: string | null;
}

export interface RlsStatusSummary {
  tables: {
    tableName: string;
    rlsEnabled: boolean;
    rlsForced: boolean;
  }[];
  policies: RlsPolicy[];
}

// Global cache for in-memory PGlite engines by instanceId
declare global {
  var __driveql_engines: Map<string, PGliteEngine> | undefined;
}

if (!globalThis.__driveql_engines) {
  globalThis.__driveql_engines = new Map<string, PGliteEngine>();
}

export async function getOrInitEngine(
  instanceId: string,
  snapshotData?: Blob | File | ArrayBuffer
): Promise<PGliteEngine> {
  let engine = globalThis.__driveql_engines!.get(instanceId);
  if (!engine) {
    engine = new PGliteEngine();
    await engine.init(snapshotData);
    globalThis.__driveql_engines!.set(instanceId, engine);
  }
  return engine;
}

export class PGliteEngine {
  private db: PGlite | null = null;
  private isInitialized = false;

  async init(dataDirSnapshot?: Blob | File | ArrayBuffer): Promise<void> {
    if (this.isInitialized && this.db) {
      return;
    }

    if (dataDirSnapshot) {
      const blob = dataDirSnapshot instanceof Blob ? dataDirSnapshot : new Blob([dataDirSnapshot]);
      this.db = new PGlite({ loadDataDir: blob });
    } else {
      this.db = new PGlite();
    }
    await this.db.waitReady;

    // 1. Ensure baseline demo tables exist for immediate exploration
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS welcome (
        id SERIAL PRIMARY KEY,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO welcome (message) 
      SELECT 'Welcome to DriveQL! PostgreSQL 16 virtualized on Google Drive.'
      WHERE NOT EXISTS (SELECT 1 FROM welcome);

      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        title VARCHAR(100) NOT NULL,
        price NUMERIC(10, 2) NOT NULL,
        inventory INT DEFAULT 0
      );
      INSERT INTO products (title, price, inventory)
      SELECT 'Serverless Postgres Node', 0.00, 100
      WHERE NOT EXISTS (SELECT 1 FROM products);
    `);

    // 2. Bootstrap standard PostgreSQL Row-Level Security roles & default permissions
    await this.db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOSUPERUSER NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOSUPERUSER NOLOGIN;
        END IF;
      END
      $$;

      GRANT ALL ON SCHEMA public TO authenticated, anon;
      GRANT CREATE ON SCHEMA public TO authenticated, anon;
      GRANT USAGE ON SCHEMA public TO authenticated, anon;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, anon;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, anon;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, anon;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, anon;
    `);

    this.isInitialized = true;
  }

  /**
   * Executes a single or batch SQL query with full RLS session context and role simulation.
   */
  async executeInContext(options: {
    query: string;
    params?: any[];
    rlsContext?: {
      userId?: string;
      role?: 'anon' | 'authenticated' | 'admin' | string;
    };
  }): Promise<QueryResult> {
    if (!this.db) {
      await this.init();
    }

    const { query, params, rlsContext } = options;
    const requestedRole = rlsContext?.role || 'admin';
    const userId = rlsContext?.userId || 'anonymous';

    const sanitizedUserId = userId.replace(/'/g, "''");
    const isSuperuserMode = requestedRole === 'admin' || requestedRole === 'postgres';
    const targetPgRole = requestedRole === 'anon' ? 'anon' : requestedRole === 'authenticated' ? 'authenticated' : 'postgres';

    const start = performance.now();

    try {
      // Step 1: Set session context variables and role
      const setupScript = `
        RESET ROLE;
        SET "app.current_user_id" = '${sanitizedUserId}';
        SET "app.user_role" = '${targetPgRole}';
        ${!isSuperuserMode ? `SET ROLE ${targetPgRole};` : ''}
      `;
      await this.db!.exec(setupScript);

      // Step 2: Execute query
      let resultRows: any[] = [];
      let resultFields: { name: string; dataTypeID: number }[] = [];
      let affectedRows = 0;

      if (params && params.length > 0) {
        const queryRes = await this.db!.query(query, params);
        resultRows = queryRes.rows;
        resultFields = queryRes.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID }));
        affectedRows = queryRes.rows.length;
      } else {
        const batchRes = await this.db!.exec(query);
        if (Array.isArray(batchRes) && batchRes.length > 0) {
          // Find the last statement that returned rows, or default to the final statement
          const lastWithRows = [...batchRes].reverse().find((r) => r.rows && r.rows.length > 0);
          const finalRes = lastWithRows || batchRes[batchRes.length - 1];

          resultRows = finalRes.rows || [];
          resultFields = (finalRes.fields || []).map((f: any) => ({ name: f.name, dataTypeID: f.dataTypeID }));
          affectedRows = finalRes.affectedRows ?? resultRows.length;
        }
      }

      const durationMs = Math.round((performance.now() - start) * 100) / 100;

      return {
        rows: resultRows,
        fields: resultFields,
        rowCount: resultRows.length > 0 ? resultRows.length : affectedRows,
        durationMs,
      };
    } finally {
      // Always reset role to superuser to prevent poisoning subsequent queries
      try {
        await this.db!.exec('RESET ROLE;');
      } catch {
        // ignore reset failure
      }
    }
  }

  /**
   * Executes a single SQL query with parameter binding (backward compatibility).
   */
  async query(sql: string, params: any[] = []): Promise<QueryResult> {
    return this.executeInContext({ query: sql, params, rlsContext: { role: 'admin' } });
  }

  /**
   * Executes multiple SQL statements in batch (backward compatibility).
   */
  async exec(sql: string): Promise<void> {
    if (!this.db) {
      await this.init();
    }
    await this.db!.exec(sql);
  }

  /**
   * Inspects tables and schemas in the database.
   */
  async inspectSchema(): Promise<TableSummary[]> {
    if (!this.db) {
      await this.init();
    }

    const tablesQuery = `
      SELECT t.table_name,
             COALESCE(c.relrowsecurity, false) as rls_enabled
      FROM information_schema.tables t
      LEFT JOIN pg_class c ON c.relname = t.table_name
      LEFT JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE t.table_schema = 'public' 
        AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name;
    `;
    const tablesRes = await this.query(tablesQuery);

    const summaries: TableSummary[] = [];

    for (const row of tablesRes.rows) {
      const tableName = row.table_name;

      const colsQuery = `
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position;
      `;
      const colsRes = await this.query(colsQuery, [tableName]);

      let rowCount = 0;
      try {
        const countRes = await this.query(`SELECT count(*)::int as count FROM "${tableName}";`);
        rowCount = countRes.rows[0]?.count || 0;
      } catch {
        // ignore on system error
      }

      summaries.push({
        tableName,
        columns: colsRes.rows,
        rowCount,
        rlsEnabled: Boolean(row.rls_enabled),
      });
    }

    return summaries;
  }

  /**
   * Inspects all active Row-Level Security policies and table status.
   */
  async inspectPolicies(): Promise<RlsStatusSummary> {
    if (!this.db) {
      await this.init();
    }

    const tablesRes = await this.query(`
      SELECT 
        c.relname as table_name,
        c.relrowsecurity as rls_enabled,
        c.relforcerowsecurity as rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname;
    `);

    const policiesRes = await this.query(`
      SELECT 
        schemaname,
        tablename,
        policyname,
        roles,
        cmd,
        qual as using_clause,
        with_check as with_check_clause
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename, policyname;
    `);

    return {
      tables: tablesRes.rows.map((r) => ({
        tableName: r.table_name,
        rlsEnabled: Boolean(r.rls_enabled),
        rlsForced: Boolean(r.rls_forced),
      })),
      policies: policiesRes.rows.map((p) => ({
        schemaname: p.schemaname,
        tablename: p.tablename,
        policyname: p.policyname,
        roles: Array.isArray(p.roles) ? p.roles : [String(p.roles)],
        cmd: p.cmd,
        using_clause: p.using_clause,
        with_check_clause: p.with_check_clause,
      })),
    };
  }

  /**
   * Dumps the entire in-memory database state as a gzipped tarball for Google Drive upload.
   */
  async dumpSnapshot(): Promise<Blob> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    return await this.db.dumpDataDir('gzip');
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      this.isInitialized = false;
    }
  }
}
