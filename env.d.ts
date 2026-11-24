/// <reference types="astro/client" />

type D1Database = import('@cloudflare/workers-types').D1Database;

type Runtime = import('@astrojs/cloudflare').Runtime<{
  DB: D1Database;
  ENCRYPTION_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  APP_URL: string;
}>;

declare namespace App {
  interface Locals extends Runtime {}
}

interface ImportMetaEnv {
  readonly GOOGLE_CLIENT_ID: string;
  readonly GOOGLE_CLIENT_SECRET: string;
  readonly ENCRYPTION_SECRET: string;
  readonly APP_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
