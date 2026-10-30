# EgyBook Reels + Shared Media Worker

Cloudflare Worker backend for EgyBook. It stores uploaded media in the R2 bucket and keeps reel metadata/interactions in Neon.

## Runtime secrets
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (public anon/publishable key accepted by the Supabase Auth user endpoint)
- `NEON_DATABASE_URL` (pooled Neon connection string)

## R2 binding
- `REELS_BUCKET` -> `egybook-reels`

## Routes
- `GET /` health check
- `POST /media` authenticated upload; multipart fields: `file`, optional `folder` (`posts`, `profile`, `comments`, `reels`, `other`); image/video/audio only; max 50 MB
- `GET|HEAD /media/:objectKey` public media delivery; supports HTTP byte ranges for video/audio playback
- `GET /reels`
- `POST /reels` authenticated reel video upload (max 100 MB)
- `POST /reels/:id/like`
- `DELETE /reels/:id/like`
- `GET /reels/:id/comments`
- `POST /reels/:id/comments` (JSON: `{"comment_text":"..."}`)

All write routes require `Authorization: Bearer <Supabase access token>`.

## Build and deploy
- Build command: `npm install`
- Deploy command: `npx wrangler deploy`

## Storage behavior and migration safety
- Shared image/video/audio uploads are written to R2 and do not initialize or query Neon.
- Neon is initialized only for reel metadata and interaction routes.
- The EgyBook client in this package already routes post media, profile/cover images, and comment attachments through the authenticated `/media` route.
- Existing Supabase Storage objects are NOT copied or deleted by this release. Their existing URLs remain in place and continue to be used until a separate, verified migration updates the corresponding database references.
- Do not empty or delete the Supabase `post-media` bucket as part of this deployment. Migration requires a separate inventory/copy/verification/update process with authorized access to the existing objects and database.

Existing files in Supabase Storage are not deleted or migrated by this Worker. Existing URLs remain available; new uploads from the updated EgyBook client are sent to R2.
