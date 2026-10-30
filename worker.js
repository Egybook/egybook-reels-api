import { neon } from "@neondatabase/serverless";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", ...headers },
  });

async function getUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: auth,
    },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.id ? user : null;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/" && request.method === "GET") {
        return json({ ok: true, service: "egybook-reels-api" });
      }

      // Private R2 objects are streamed through this Worker.
      if (path.startsWith("/media/") && request.method === "GET") {
        const key = decodeURIComponent(path.slice(7));
        if (!key || key.includes("..")) return json({ error: "Invalid media key" }, 400);
        const object = await env.REELS_BUCKET.get(key);
        if (!object) return json({ error: "Media not found" }, 404);
        const headers = new Headers(CORS);
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        return new Response(object.body, { headers });
      }

      const user = request.method === "GET" ? null : await getUser(request, env);
      if (request.method !== "GET" && !user) return json({ error: "Unauthorized" }, 401);

      const sql = neon(env.NEON_DATABASE_URL);

      if (path === "/reels" && request.method === "GET") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 50);
        const rows = await sql`
          SELECT r.id, r.user_id, r.video_url, r.thumbnail_url, r.caption, r.created_at,
            (SELECT COUNT(*)::int FROM reel_likes l WHERE l.reel_id = r.id) AS likes_count,
            (SELECT COUNT(*)::int FROM reel_comments c WHERE c.reel_id = r.id) AS comments_count
          FROM reels r ORDER BY r.created_at DESC LIMIT ${limit}
        `;
        return json({ reels: rows });
      }

      if (path === "/reels" && request.method === "POST") {
        const form = await request.formData();
        const file = form.get("video");
        const caption = String(form.get("caption") || "").slice(0, 2000);
        if (!(file instanceof File)) return json({ error: "Video field is required" }, 400);
        if (!file.type.startsWith("video/")) return json({ error: "Only video files are allowed" }, 415);
        if (file.size > 100 * 1024 * 1024) return json({ error: "Maximum video size is 100 MB" }, 413);

        const filename = String(file.name || "video.mp4").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-90);
        const key = `reels/${user.id}/${crypto.randomUUID()}-${filename}`;
        await env.REELS_BUCKET.put(key, file.stream(), {
          httpMetadata: { contentType: file.type },
          customMetadata: { owner: user.id },
        });
        const videoUrl = `${url.origin}/media/${encodeURIComponent(key)}`;

        try {
          const rows = await sql`
            INSERT INTO reels (user_id, video_url, caption)
            VALUES (${user.id}, ${videoUrl}, ${caption})
            RETURNING id, user_id, video_url, thumbnail_url, caption, created_at
          `;
          return json({ reel: rows[0] }, 201);
        } catch (e) {
          await env.REELS_BUCKET.delete(key);
          throw e;
        }
      }

      const like = path.match(/^\/reels\/(\d+)\/like$/);
      if (like && request.method === "POST") {
        const rows = await sql`
          INSERT INTO reel_likes (reel_id, user_id) VALUES (${Number(like[1])}, ${user.id})
          ON CONFLICT (reel_id, user_id) DO NOTHING RETURNING id
        `;
        return json({ liked: true, created: rows.length > 0 });
      }
      if (like && request.method === "DELETE") {
        await sql`DELETE FROM reel_likes WHERE reel_id = ${Number(like[1])} AND user_id = ${user.id}`;
        return json({ liked: false });
      }

      const comments = path.match(/^\/reels\/(\d+)\/comments$/);
      if (comments && request.method === "GET") {
        const rows = await sql`
          SELECT id, reel_id, user_id, comment_text, created_at
          FROM reel_comments WHERE reel_id = ${Number(comments[1])}
          ORDER BY created_at ASC LIMIT 200
        `;
        return json({ comments: rows });
      }
      if (comments && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const text = String(body.comment_text || "").trim().slice(0, 2000);
        if (!text) return json({ error: "Comment cannot be empty" }, 400);
        const rows = await sql`
          INSERT INTO reel_comments (reel_id, user_id, comment_text)
          VALUES (${Number(comments[1])}, ${user.id}, ${text})
          RETURNING id, reel_id, user_id, comment_text, created_at
        `;
        return json({ comment: rows[0] }, 201);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error("EgyBook Reels API:", error);
      return json({ error: "Internal server error" }, 500);
    }
  },
};
