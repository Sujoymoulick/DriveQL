/**
 * Environment Configuration Helper
 * Safely extracts environment variables across Cloudflare Workers runtime and local dev.
 */

export function getEnv(locals?: any): {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ENCRYPTION_SECRET: string;
  APP_URL: string;
} {
  const runtimeEnv = locals?.runtime?.env || {};

  const GOOGLE_CLIENT_ID =
    runtimeEnv.GOOGLE_CLIENT_ID ||
    import.meta.env.GOOGLE_CLIENT_ID ||
    process.env.GOOGLE_CLIENT_ID ||
    '';

  const GOOGLE_CLIENT_SECRET =
    runtimeEnv.GOOGLE_CLIENT_SECRET ||
    import.meta.env.GOOGLE_CLIENT_SECRET ||
    process.env.GOOGLE_CLIENT_SECRET ||
    '';

  const ENCRYPTION_SECRET =
    runtimeEnv.ENCRYPTION_SECRET ||
    import.meta.env.ENCRYPTION_SECRET ||
    process.env.ENCRYPTION_SECRET ||
    'default-encryption-secret-32-bytes-needed';

  const APP_URL =
    runtimeEnv.APP_URL ||
    import.meta.env.APP_URL ||
    process.env.APP_URL ||
    'http://localhost:4321';

  return {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    ENCRYPTION_SECRET,
    APP_URL,
  };
}

export const getRuntimeEnv = getEnv;
