import { neon } from "@neondatabase/serverless";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, Range",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, ETag",
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

      // Public media delivery from R2, including byte-range requests for video/audio seeking.
      if (path.startsWith("/media/") && (request.method === "GET" || request.method === "HEAD")) {
        const key = decodeURIComponent(path.slice(7));
        if (!key || key.includes("..") || key.startsWith("/")) return json({ error: "Invalid media key" }, 400);
        const rangeHeader = request.headers.get("Range");
        let range;
        if (rangeHeader) {
          const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
          if (!match) return new Response(null, { status: 416, headers: { ...CORS, "Content-Range": "bytes */*" } });
          const objectInfo = await env.REELS_BUCKET.head(key);
          if (!objectInfo) return json({ error: "Media not found" }, 404);
          const size = objectInfo.size;
          let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2] || 0));
          let end = match[2] && match[1] ? Number(match[2]) : size - 1;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
            return new Response(null, { status: 416, headers: { ...CORS, "Content-Range": `bytes */${size}` } });
          }
          end = Math.min(end, size - 1);
          range = { offset: start, length: end - start + 1 };
        }
        const object = await env.REELS_BUCKET.get(key, range ? { range } : undefined);
        if (!object) return json({ error: "Media not found" }, 404);
        const headers = new Headers(CORS);
        object.writeHttpMetadata(headers);
        headers.set("ETag", object.httpEtag);
        headers.set("Accept-Ranges", "bytes");
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        headers.set("X-Content-Type-Options", "nosniff");
        if (range && object.range) {
          const start = object.range.offset;
          const end = start + object.range.length - 1;
          headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
          headers.set("Content-Length", String(object.range.length));
        } else {
          headers.set("Content-Length", String(object.size));
        }
        if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
        return new Response(object.body, { status: range ? 206 : 200, headers });
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

      // Upload shared EgyBook media (images, videos and audio) to R2.
      if (path === "/media" && request.method === "POST") {
        const form = await request.formData();
        const file = form.get("file");
        const folderRaw = String(form.get("folder") || "posts").toLowerCase();
        const allowedFolders = new Set(["posts", "profile", "comments", "reels", "other"]);
        const folder = allowedFolders.has(folderRaw) ? folderRaw : "posts";
        if (!(file instanceof File)) return json({ error: "File field is required" }, 400);
        const mime = String(file.type || "application/octet-stream").toLowerCase();
        if (!(mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/"))) {
          return json({ error: "Only image, video and audio files are allowed" }, 415);
        }
        if (file.size <= 0 || file.size > 50 * 1024 * 1024) {
          return json({ error: "Maximum media size is 50 MB" }, 413);
        }
        const original = String(file.name || "media.bin").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
        const key = `${folder}/${user.id}/${crypto.randomUUID()}-${original}`;
        await env.REELS_BUCKET.put(key, file.stream(), {
          httpMetadata: { contentType: mime, contentDisposition: "inline" },
          customMetadata: { owner: user.id, category: folder },
        });
        return json({ url: `${url.origin}/media/${key.split("/").map(encodeURIComponent).join("/")}`, key, size: file.size, content_type: mime }, 201);
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
