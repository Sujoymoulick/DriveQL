# DriveQL: Provider Setup & Environment Guide

This guide provides step-by-step instructions on how to acquire and configure all required credentials and environment variables for **DriveQL** using **100% free resources**.

---

## 1. Environment Variables Overview

| Variable | Required? | Source / Provider | Description | Example Format |
| :--- | :--- | :--- | :--- | :--- |
| `GOOGLE_CLIENT_ID` | **Yes** | Google Cloud Console | OAuth 2.0 Web Client ID | `123456789-abc.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | **Yes** | Google Cloud Console | OAuth 2.0 Client Secret | `GOCSPX-abc123xyz456` |
| `ENCRYPTION_SECRET` | **Yes** | Built-in (Local Keygen) | 32-byte hex for AES-256-GCM token encryption | `cbb67e9c22cfdf77e2ea97be28880e33ce1e2...` |
| `APP_URL` | **Yes** | Local / Cloudflare | The base URL where your app is running | `http://localhost:4321` or `https://driveql.yourname.workers.dev` |

---

## 2. Provider 1: Google Cloud Console (Drive API & OAuth)

Google Cloud Platform provides free OAuth 2.0 credentials and **20,000 queries per 100 seconds** of Google Drive API calls completely free.

### Step-by-Step Setup:

### 1. Create a Google Cloud Project
1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Click on the project dropdown at the top-left and select **New Project**.
3. Name it **DriveQL-Database** and click **Create**.

### 2. Enable Google Drive API
1. In the search bar at the top, search for **Google Drive API**.
2. Click on **Google Drive API** and click the blue **Enable** button.

### 3. Configure the OAuth Consent Screen
1. In the left sidebar, navigate to **APIs & Services → OAuth consent screen**.
2. Under **User Type**, select **External** and click **Create**.
3. Fill in the required fields:
   - **App name**: `DriveQL`
   - **User support email**: Your Gmail address
   - **Developer contact email**: Your Gmail address
4. Click **Save and Continue**.
5. Under **Scopes**, click **Add or Remove Scopes** and add:
   - `https://www.googleapis.com/auth/drive.file` *(Allows app to read and write only files that it creates)*
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`
   > **Note on Safety:** By using `drive.file`, DriveQL **never** accesses your personal files, photos, or existing docs. Google will NOT show unverified app warnings or require costly third-party security audits!
6. Under **Test users**, click **+ ADD USERS** and enter the Gmail accounts you want to connect to DriveQL (including your personal or secondary accounts).
7. Click **Save and Continue**.

### 4. Create OAuth 2.0 Client Credentials
1. In the left sidebar, navigate to **APIs & Services → Credentials**.
2. Click **+ CREATE CREDENTIALS** at the top and select **OAuth client ID**.
3. Under **Application type**, select **Web application**.
4. Set **Name** to: `DriveQL Web Client`.
5. Under **Authorized JavaScript origins**, add:
   - `http://localhost:4321`
   - *(Optional production URL)*: `https://driveql.yourname.workers.dev`
6. Under **Authorized redirect URIs**, add:
   - `http://localhost:4321/api/auth/google/callback`
   - *(Optional production URI)*: `https://driveql.yourname.workers.dev/api/auth/google/callback`
7. Click **Create**.
8. A modal will display your **Client ID** and **Client Secret**.
9. Copy them into your `.env` file:
   ```env
   GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
   GOOGLE_CLIENT_SECRET="GOCSPX-your-client-secret"
   ```

---

## 3. Provider 2: Token Encryption Secret (`ENCRYPTION_SECRET`)

To protect user tokens, DriveQL encrypts Google OAuth refresh tokens at rest in Cloudflare D1 using **AES-256-GCM** hardware encryption via the standard Web Crypto API.

### How to Generate:
We have already pre-generated one for your local `.env`, but if you ever need a fresh 32-byte key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add the resulting 64-character hexadecimal string to `.env`:
```env
ENCRYPTION_SECRET="cbb67e9c22cfdf77e2ea97be28880e33ce1e2ccc22c3b04ccccd620c436280ef"
```

---

## 4. Provider 3: Cloudflare Workers & D1 Database (Edge Deployment)

Cloudflare provides a 100% free tier:
- **100,000 requests/day** on Cloudflare Workers
- **5 GB of storage** and **5 million reads/day** on Cloudflare D1
- **Free SSL/TLS** edge termination

### Step-by-Step Cloudflare Setup:

### 1. Log in to Cloudflare CLI
If deploying to Cloudflare Workers, authenticate via wrangler:
```bash
npx wrangler login
```

### 2. Create the Free D1 Database
Create the platform metadata database in your Cloudflare account:
```bash
npx wrangler d1 create driveql-d1
```

Wrangler will output:
```toml
[[d1_databases]]
binding = "DB"
database_name = "driveql-d1"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy that `database_id` and replace the placeholder in your [wrangler.toml](file:///Volumes/projects/DriveQL/wrangler.toml).

### 3. Apply Schema Migrations
Execute the initial SQL schema migrations into your D1 database:
```bash
npx wrangler d1 execute driveql-d1 --file=./migrations/0001_initial.sql
```

### 4. Upload Production Secrets
Store your secrets securely on the Cloudflare edge:
```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ENCRYPTION_SECRET
```

### 5. Deploy Live to Cloudflare Workers
```bash
npm run build
npx wrangler deploy
```

Your DriveQL platform is now live on Cloudflare's global edge network!

---

## 5. Local Development Workflow

You can run DriveQL completely locally without even needing Cloudflare credentials first:

```bash
# 1. Start Astro development server
npm run dev

# 2. Open dashboard in your browser
open http://localhost:4321/dashboard
```

When running locally, DriveQL automatically activates its **In-Memory fallback store** if Cloudflare D1 is not bound, allowing you to test UI, OAuth flows, and PGlite database queries immediately.

---

## 6. How to Connect External Tools (Prisma, Drizzle, psql)

DriveQL includes a local PostgreSQL wire proxy bridge (`driveql-proxy`):

1. Generate an API Key in the dashboard under your database instance.
2. Run the proxy bridge:
   ```bash
   node ./src/cli/proxy.mjs --instance <YOUR_INSTANCE_ID> --token <YOUR_API_KEY>
   ```
3. Connect with any standard PostgreSQL client:
   ```bash
   psql -h 127.0.0.1 -p 5432 -U postgres -d driveql
   ```
4. Or configure your ORM `.env`:
   ```env
   DATABASE_URL="postgresql://postgres:YOUR_API_KEY@localhost:5432/driveql?sslmode=disable"
   ```
