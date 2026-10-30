# EgyBook Reels API

Backend service only; this is not a second website.

Required Cloudflare Worker secrets:
- SUPABASE_URL
- SUPABASE_ANON_KEY (Supabase public anon key)
- NEON_DATABASE_URL (pooled Neon connection string)

R2 binding:
- REELS_BUCKET -> egybook-reels

Routes:
- GET /
- GET /reels
- POST /reels (multipart fields: video, optional caption; max 100 MB)
- POST /reels/:id/like
- DELETE /reels/:id/like
- GET /reels/:id/comments
- POST /reels/:id/comments (JSON: {"comment_text":"..."})
- GET /media/:objectKey

Write routes require Authorization: Bearer <Supabase access token>.
Deploy with Cloudflare Workers Builds:
Build command: npm install
Deploy command: npx wrangler deploy
