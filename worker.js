import { neon } from "@neondatabase/serverless";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });

async function getUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;

  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: auth,
    },
  });
  if (!response.ok) return null;

  const user = await response.json();
  return user?.id ? user : null;
}

function safeFilename(name) {
  const cleaned = String(name || "media.bin")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(-100);
  return cleaned || "media.bin";
}

function isSafeObjectKey(key) {
  return Boolean(
    key &&
      !key.startsWith("/") &&
      !key.includes("\\") &&
      !key.split("/").some((part) => !part || part === "." || part === "..")
  );
}

async function serveMedia(key, env) {
  if (!isSafeObjectKey(key)) {
    return json({ error: "Invalid media key" }, 400);
  }

  // Existing reel objects remain in the old reels bucket.
  // Posts and profile media are served from the new general media bucket.
  const isReel = key.startsWith("reels/");
  const bucket = isReel ? env.REELS_BUCKET : env.MEDIA_BUCKET;
  if (!bucket) return json({ error: "Storage binding is not configured" }, 503);

  const object = await bucket.get(key);
  if (!object) return json({ error: "Media not found" }, 404);

  const headers = new Headers(CORS);
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}

async function uploadMedia(request, env, user, url) {
  if (!env.MEDIA_BUCKET) {
    return json({ error: "MEDIA_BUCKET binding is not configured" }, 503);
  }

  const form = await request.formData();
  const file = form.get("file");
  const folder = String(form.get("folder") || "posts");

  if (!(file instanceof File)) {
    return json({ error: "File field is required" }, 400);
  }
  if (!["posts", "profile"].includes(folder)) {
    return json({ error: "Invalid folder" }, 400);
  }
  if (!file.type || !/^(image|video|audio)\//i.test(file.type)) {
    return json({ error: "Only image, video, and audio files are allowed" }, 415);
  }
  if (file.size <= 0) return json({ error: "Empty file" }, 400);
  if (file.size > 50 * 1024 * 1024) {
    return json({ error: "Maximum file size is 50 MB" }, 413);
  }

  // One root folder per Supabase account, then a media category.
  const filename = safeFilename(file.name);
  const key = `${user.id}/${folder}/${crypto.randomUUID()}-${filename}`;

  await env.MEDIA_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: {
      owner: user.id,
      folder,
      originalName: filename,
      uploadedAt: new Date().toISOString(),
    },
  });

  const saved = await env.MEDIA_BUCKET.head(key);
  if (!saved || saved.size !== file.size) {
    await env.MEDIA_BUCKET.delete(key);
    return json({ error: "Upload verification failed" }, 500);
  }

  return json(
    {
      ok: true,
      key,
      owner_id: user.id,
      folder,
      size: saved.size,
      url: `${url.origin}/media/${key}`,
    },
    201
  );
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/" && request.method === "GET") {
        return json({
          ok: true,
          service: "egybook-media-api",
          mediaBucket: "egybook-media",
          reelsBucket: "egybook-reels",
        });
      }

      if (path.startsWith("/media/") && request.method === "GET") {
        let key;
        try {
          key = decodeURIComponent(path.slice(7));
        } catch {
          return json({ error: "Invalid media key" }, 400);
        }
        return serveMedia(key, env);
      }

      const user =
        request.method === "GET" ? null : await getUser(request, env);
      if (request.method !== "GET" && !user) {
        return json({ error: "Unauthorized" }, 401);
      }

      if (path === "/media" && request.method === "POST") {
        return uploadMedia(request, env, user, url);
      }

      const sql = neon(env.NEON_DATABASE_URL);

      if (path === "/reels" && request.method === "GET") {
        const limit = Math.min(
          Math.max(Number(url.searchParams.get("limit") || 20), 1),
          50
        );
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
        if (!(file instanceof File)) {
          return json({ error: "Video field is required" }, 400);
        }
        if (!file.type.startsWith("video/")) {
          return json({ error: "Only video files are allowed" }, 415);
        }
        if (file.size > 100 * 1024 * 1024) {
          return json({ error: "Maximum video size is 100 MB" }, 413);
        }
        if (!env.REELS_BUCKET) {
          return json({ error: "REELS_BUCKET binding is not configured" }, 503);
        }

        const filename = safeFilename(file.name || "video.mp4");
        const key = `reels/${user.id}/${crypto.randomUUID()}-${filename}`;
        await env.REELS_BUCKET.put(key, file.stream(), {
          httpMetadata: { contentType: file.type },
          customMetadata: { owner: user.id },
        });
        const videoUrl = `${url.origin}/media/${key}`;

        try {
          const rows = await sql`
            INSERT INTO reels (user_id, video_url, caption)
            VALUES (${user.id}, ${videoUrl}, ${caption})
            RETURNING id, user_id, video_url, thumbnail_url, caption, created_at
          `;
          return json({ reel: rows[0] }, 201);
        } catch (error) {
          await env.REELS_BUCKET.delete(key);
          throw error;
        }
      }

      const like = path.match(/^\/reels\/(\d+)\/like$/);
      if (like && request.method === "POST") {
        const rows = await sql`
          INSERT INTO reel_likes (reel_id, user_id)
          VALUES (${Number(like[1])}, ${user.id})
          ON CONFLICT (reel_id, user_id) DO NOTHING
          RETURNING id
        `;
        return json({ liked: true, created: rows.length > 0 });
      }
      if (like && request.method === "DELETE") {
        await sql`
          DELETE FROM reel_likes
          WHERE reel_id = ${Number(like[1])} AND user_id = ${user.id}
        `;
        return json({ liked: false });
      }

      const comments = path.match(/^\/reels\/(\d+)\/comments$/);
      if (comments && request.method === "GET") {
        const rows = await sql`
          SELECT id, reel_id, user_id, comment_text, created_at
          FROM reel_comments
          WHERE reel_id = ${Number(comments[1])}
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
      console.error("EgyBook Media API:", error);
      return json({ error: "Internal server error" }, 500);
    }
  },
};
