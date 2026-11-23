import { neon } from "@neondatabase/serverless";
import { filterReelCatalogRowsForViewer, isUnifiedVideoObjectKey, selectMediaBucketForKey } from "./egybook-media-safety-v2381.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Access-Control-Expose-Headers": "ETag, Content-Range, Accept-Ranges",
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


// Hovod private-playback bridge.
// Ticket issuance and refresh are delegated to the Supabase Edge Function,
// which owns the trusted playback_id -> post_id mapping and audience checks.
async function callPlaybackAuthorization(env, {
  playbackId,
  authorization = '',
  refreshSecret = '',
  userId = '',
  currentTicket = '',
  currentTicketId = '',
}) {
  if (!env.EGYBOOK_PLAYBACK_AUTH_URL) {
    throw new Error('EgyBook playback authorization URL is not configured');
  }

  const headers = { 'content-type': 'application/json' };
  if (authorization) headers.Authorization = authorization;
  if (refreshSecret) headers['x-hovod-refresh-secret'] = refreshSecret;

  const body = refreshSecret
    ? { playbackId, userId, currentTicket, currentTicketId }
    : { playbackId };

  const response = await fetch(env.EGYBOOK_PLAYBACK_AUTH_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return false;
  const result = await response.json().catch(() => null);
  if (!result || typeof result.ticket !== 'string' || !result.ticket ||
      !Number.isInteger(result.expiresAt) || !Number.isInteger(result.refreshAfterSec)) {
    return false;
  }
  return result;
}

function timingSafeSecretEqual(expected, supplied) {
  if (typeof expected !== 'string' || !expected || typeof supplied !== 'string' ||
      expected.length !== supplied.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return diff === 0;
}

async function handleHovodTicket(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401, { 'Cache-Control': 'no-store' });
  const body = await request.json().catch(() => null);
  const playbackId = typeof body?.playbackId === 'string' ? body.playbackId.trim() : '';
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(playbackId)) return json({ error: 'Invalid playbackId' }, 400);

  try {
    const issued = await callPlaybackAuthorization(env, {
      playbackId,
      authorization: request.headers.get('Authorization') || '',
    });
    if (!issued) return json({ error: 'Playback is not authorized' }, 403, { 'Cache-Control': 'no-store' });
    return json({ ok: true, playbackId, ...issued }, 200, {
      'Cache-Control': 'no-store, private, max-age=0',
      'Pragma': 'no-cache',
      'Referrer-Policy': 'no-referrer',
    });
  } catch {
    return json({ error: 'Playback authorization service unavailable' }, 503, { 'Cache-Control': 'no-store' });
  }
}

async function handleHovodRefresh(request, env) {
  const expected = env.EGYBOOK_HOVOD_REFRESH_SECRET || env.EGYBOOK_PLAYBACK_AUTH_SECRET;
  const supplied = request.headers.get('x-hovod-refresh-secret') || '';
  if (!timingSafeSecretEqual(expected, supplied)) {
    return json({ error: 'Unauthorized' }, 401, { 'Cache-Control': 'no-store' });
  }

  const body = await request.json().catch(() => null);
  const playbackId = typeof body?.playbackId === 'string' ? body.playbackId.trim() : '';
  const userId = typeof body?.userId === 'string' ? body.userId : '';
  const currentTicket = typeof body?.currentTicket === 'string' ? body.currentTicket : '';
  const currentTicketId = typeof body?.currentTicketId === 'string' ? body.currentTicketId : '';
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(playbackId) || !userId || !currentTicket || !currentTicketId) {
    return json({ error: 'Invalid refresh request' }, 400, { 'Cache-Control': 'no-store' });
  }

  try {
    // Supabase verifies the current HMAC ticket and rechecks the post audience
    // before minting a replacement ticket. The Worker does not mint tickets.
    const issued = await callPlaybackAuthorization(env, {
      playbackId,
      userId,
      currentTicket,
      currentTicketId,
      refreshSecret: supplied,
    });
    if (!issued) return json({ error: 'Playback is no longer authorized' }, 403, { 'Cache-Control': 'no-store' });
    return json(issued, 200, {
      'Cache-Control': 'no-store, private, max-age=0',
      'Pragma': 'no-cache',
      'Referrer-Policy': 'no-referrer',
    });
  } catch {
    return json({ error: 'Playback authorization service unavailable' }, 503, { 'Cache-Control': 'no-store' });
  }
}

async function getUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ") || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;

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

function parseSingleByteRange(header, size) {
  if (!header) return null;
  // Multiple ranges are intentionally ignored; browsers normally request one.
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return { invalid: true };
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

// Neon database triggers write each social event into the durable outbox atomically.
async function drainReelNotificationOutbox(env, maxRows = 40) {
  if (!env.NEON_DATABASE_URL || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { delivered: 0, configured: false };
  }
  const sql = neon(env.NEON_DATABASE_URL);
  const rows = await sql`
    SELECT id, event_key, recipient_user_id, actor_user_id, notification_type,
           title, body, target_type, target_id, metadata, created_at
    FROM reel_notification_outbox
    WHERE delivered_at IS NULL
    ORDER BY created_at ASC, id ASC
    LIMIT ${Math.min(Math.max(Number(maxRows) || 40, 1), 100)}
  `;
  if (!rows.length) return { delivered: 0, configured: true };
  const payload = rows.map(row => ({
    recipient_id: row.recipient_user_id,
    actor_id: row.actor_user_id,
    type: row.notification_type,
    title: row.title,
    body: row.body,
    source: 'neon',
    event_key: row.event_key,
    target_type: row.target_type || 'reel',
    target_id: String(row.target_id),
    metadata: row.metadata || {},
    created_at: row.created_at,
  }));
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/notifications?on_conflict=event_key`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    await sql`
      UPDATE reel_notification_outbox
      SET attempts = attempts + 1, last_error = ${`Supabase ${response.status}: ${detail.slice(0, 300)}`}, updated_at = now()
      WHERE id::text = ANY(${rows.map(row => String(row.id))}::text[])
    `;
    throw new Error(`Supabase notification delivery failed (${response.status})`);
  }
  await sql`
    UPDATE reel_notification_outbox
    SET delivered_at = now(), attempts = attempts + 1, last_error = NULL, updated_at = now()
    WHERE id::text = ANY(${rows.map(row => String(row.id))}::text[])
  `;
  return { delivered: rows.length, configured: true };
}

async function deliverQueuedReelNotifications(env) {
  try {
    return await drainReelNotificationOutbox(env, 40);
  } catch (error) {
    console.warn('EgyBook notification bridge will retry from Neon outbox:', error?.message || error);
    return { delivered: 0, configured: true, retry: true };
  }
}

async function serveMedia(key, env, request, headOnly = false) {
  if (!isSafeObjectKey(key)) return json({ error: "Invalid media key" }, 400);

  // All published videos (Reels and feed videos) live in the unified video bucket.
  // Images, audio, and generated variants remain in the general media bucket.
  const bucket = selectMediaBucketForKey(key, env);
  if (!bucket) return json({ error: "Storage binding is not configured" }, 503);

  const metadata = await bucket.head(key);
  if (!metadata) return json({ error: "Media not found" }, 404);
  const headers = new Headers(CORS);
  metadata.writeHttpMetadata(headers);
  headers.set("ETag", metadata.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Length", String(metadata.size));
  if (headOnly) return new Response(null, { status: 200, headers });

  const range = parseSingleByteRange(request.headers.get("Range"), metadata.size);
  if (range?.invalid) {
    headers.set("Content-Range", `bytes */${metadata.size}`);
    return new Response(null, { status: 416, headers });
  }

  const options = range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined;
  const object = await bucket.get(key, options);
  if (!object) return json({ error: "Media not found" }, 404);
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${metadata.size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

async function hasDatabaseReference(mediaUrl, env, authorization) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new Error("Supabase reference-check configuration is missing");
  }
  const response = await fetch(
    `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/egybook_media_url_is_referenced`,
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_media_url: mediaUrl }),
    }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Supabase reference check failed (${response.status}): ${detail.slice(0, 200)}`);
  }
  const result = await response.json();
  if (typeof result !== "boolean") throw new Error("Unexpected Supabase reference-check response");
  return result;
}

async function postExistsWithServiceRole(postId, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase service-role reference check is not configured");
  }
  const endpoint = new URL(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/posts`);
  endpoint.searchParams.set("select", "id");
  endpoint.searchParams.set("id", `eq.${String(postId)}`);
  endpoint.searchParams.set("limit", "1");
  const response = await fetch(endpoint.toString(), {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Supabase post existence check failed (${response.status})`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Unexpected Supabase post lookup response");
  return rows.length > 0;
}

async function removeDeletedPostVideoRecord(mediaUrl, env, user) {
  if (!env.NEON_DATABASE_URL) throw new Error("Neon video reference check is not configured");
  const sql = neon(env.NEON_DATABASE_URL);
  const rows = await sql`
    SELECT r.id::text AS id, r.user_id, l.post_id, l.user_id AS link_user_id
    FROM reels r
    LEFT JOIN reel_post_links l ON l.reel_id = r.id
    WHERE r.video_url = ${mediaUrl}
    LIMIT 2
  `;
  if (!rows.length) return { found: false, removed: false };
  if (rows.length > 1) return { conflict: true, reason: "Multiple Neon video records reference this media" };

  const record = rows[0];
  if (String(record.user_id || "") !== String(user.id || "") ||
      (record.link_user_id && String(record.link_user_id) !== String(user.id || ""))) {
    return { forbidden: true };
  }

  // Keep the Neon record while its linked Supabase post still exists. This also
  // protects an edited post whose media URL changed but whose relation has not
  // yet been reconciled.
  if (record.post_id && await postExistsWithServiceRole(record.post_id, env)) {
    return { conflict: true, reason: "The linked post still exists; video record and object were retained" };
  }

  // Neon owns the video record and its dependent Reels interactions. Delete the
  // row first; configured foreign-key cascades remove only that record's dependents.
  // If Neon refuses the delete, the R2 object is left untouched.
  const deleted = await sql`
    DELETE FROM reels
    WHERE id::text = ${String(record.id)} AND user_id = ${user.id}
    RETURNING id::text AS id
  `;
  if (!deleted.length) return { conflict: true, reason: "Neon video record changed during deletion; object was retained" };
  return { found: true, removed: true, id: String(record.id) };
}

async function hasAuxiliaryMediaReference(mediaUrl, env) {
  // These durable media collections are outside the legacy v167 RPC. Query them
  // with the service role so a hidden row cannot be missed because of caller RLS.
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase durable media reference check is not configured");
  }
  for (const table of ["photo_album_items", "saved_photos", "profile_media_history"]) {
    const endpoint = new URL(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${table}`);
    endpoint.searchParams.set("select", "id");
    endpoint.searchParams.set("media_url", `eq.${mediaUrl}`);
    endpoint.searchParams.set("limit", "1");
    const response = await fetch(endpoint.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Supabase ${table} reference check failed (${response.status})`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error(`Unexpected ${table} reference response`);
    if (rows.length) return true;
  }
  return false;
}

async function deleteMedia(key, env, user, request, url) {
  if (!isSafeObjectKey(key)) return json({ error: "Invalid media key" }, 400);

  // Feed videos and Reels are both stored in REELS_BUCKET. All other media
  // (images/audio/variants) remain in MEDIA_BUCKET.
  const isVideo = isUnifiedVideoObjectKey(key);
  const bucket = selectMediaBucketForKey(key, env);
  if (!bucket) return json({ error: "Storage binding is not configured" }, 503);

  const object = await bucket.head(key);
  if (!object) return json({ error: "Media not found" }, 404);

  // Legacy objects without owner metadata are deliberately retained.
  if (object.customMetadata?.owner !== user.id) {
    return json({ error: "Forbidden: object ownership is not verified" }, 403);
  }

  const mediaUrl = `${url.origin}/media/${key}`;
  let referenced;
  try {
    referenced = await hasDatabaseReference(mediaUrl, env, request.headers.get("Authorization") || "");
    if (!referenced) referenced = await hasAuxiliaryMediaReference(mediaUrl, env);
  } catch (error) {
    console.error("Media reference check failed; retaining object:", error);
    return json({ error: "Could not verify all media references; file was kept" }, 503);
  }
  if (referenced) {
    return json({ error: "Media is still referenced and was kept" }, 409);
  }

  if (isVideo) {
    try {
      const result = await removeDeletedPostVideoRecord(mediaUrl, env, user);
      if (result.forbidden) return json({ error: "Forbidden: video record ownership is not verified" }, 403);
      if (result.conflict) return json({ error: result.reason || "Video record is still referenced and was kept" }, 409);
    } catch (error) {
      console.error("Neon video cleanup failed; retaining R2 object:", error);
      return json({ error: "Could not safely reconcile the Neon video record; file was kept" }, 503);
    }
  }

  // Neon row cleanup is committed before R2 deletion. If R2 deletion fails,
  // retrying this endpoint can safely finish removing the now-unreferenced object.
  await bucket.delete(key);
  const remaining = await bucket.head(key);
  if (remaining) return json({ error: "Media deletion verification failed" }, 500);
  return json({ ok: true, deleted: true, key });
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
  if (file.type.startsWith("video/")) {
    return json({ error: "Video uploads must use the multipart endpoint" }, 413);
  }
  const directLimit = file.type.startsWith("image/") ? 12 * 1024 * 1024 : 50 * 1024 * 1024;
  if (file.size > directLimit) {
    return json({ error: file.type.startsWith("image/") ? "Maximum image size is 12 MB" : "Maximum audio size is 50 MB" }, 413);
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


const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const VIDEO_PART_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_PARTS = Math.ceil(MAX_VIDEO_BYTES / VIDEO_PART_BYTES);

function multipartBucket(kind, env, key = "") {
  return (kind === "reels" || key.startsWith("videos/") || key.startsWith("reels/"))
    ? env.REELS_BUCKET
    : env.MEDIA_BUCKET;
}

function multipartPrefixes(kind, userId) {
  return kind === "reels"
    ? [`reels/${userId}/`]
    : [`videos/${userId}/`, `${userId}/posts/`, `${userId}/variants/`];
}

async function initVideoMultipart(request, env, user, url, kind) {
  const body = await request.json().catch(() => null);
  if (!body || !Number.isSafeInteger(Number(body.size))) return json({ error: "Invalid upload details" }, 400);
  const size = Number(body.size);
  const contentType = String(body.contentType || "");
  if (!contentType.startsWith("video/")) return json({ error: "Only video files are allowed" }, 415);
  if (size <= 0 || size > MAX_VIDEO_BYTES) return json({ error: "Maximum video size is 300 MB" }, 413);
  const filename = safeFilename(body.fileName || "video.mp4");
  const folder = kind === "reels" ? "reels" : (body.folder === "variants" ? "variants" : "posts");
  if (kind !== "reels" && body.folder && !["posts", "variants"].includes(body.folder)) return json({ error: "Invalid upload folder" }, 400);
  const key = kind === "reels"
    ? `reels/${user.id}/${crypto.randomUUID()}-${filename}`
    : folder === "posts"
      ? `videos/${user.id}/${crypto.randomUUID()}-${filename}`
      : `${user.id}/${folder}/${crypto.randomUUID()}-${filename}`;
  const bucket = multipartBucket(kind, env, key);
  if (!bucket) return json({ error: "Video storage binding is not configured" }, 503);
  const metadata = {
    owner: user.id,
    folder,
    originalName: filename,
    declaredSize: String(size),
    uploadedAt: new Date().toISOString(),
  };
  if (kind === "reels") metadata.caption = String(body.caption || "").slice(0, 2000);
  try {
    const upload = await bucket.createMultipartUpload(key, {
      httpMetadata: { contentType },
      customMetadata: metadata,
    });
    return json({ ok: true, key, uploadId: upload.uploadId, partSize: VIDEO_PART_BYTES, totalParts: Math.ceil(size / VIDEO_PART_BYTES) }, 201);
  } catch (error) {
    console.error("Multipart initialization failed:", error);
    return json({ error: "Could not start multipart upload" }, 500);
  }
}

function validateMultipartOwnership(key, uploadId, user, kind) {
  return Boolean(
    typeof key === "string" && isSafeObjectKey(key) &&
    typeof uploadId === "string" && uploadId.length > 0 && uploadId.length <= 512 &&
    multipartPrefixes(kind, user.id).some((prefix) => key.startsWith(prefix))
  );
}

async function uploadVideoPart(request, env, user, url, kind) {
  const key = url.searchParams.get("key");
  const uploadId = url.searchParams.get("uploadId");
  const partNumber = Number(url.searchParams.get("partNumber"));
  const fileSize = Number(url.searchParams.get("fileSize"));
  if (!validateMultipartOwnership(key, uploadId, user, kind)) return json({ error: "Invalid upload ownership" }, 403);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_VIDEO_PARTS) return json({ error: "Invalid part number" }, 400);
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > MAX_VIDEO_BYTES) return json({ error: "Invalid video size" }, 400);
  const expectedParts = Math.ceil(fileSize / VIDEO_PART_BYTES);
  if (partNumber > expectedParts) return json({ error: "Part number exceeds declared file size" }, 400);
  if (!request.body) return json({ error: "Part body is required" }, 400);
  const expectedPartSize = partNumber === expectedParts ? fileSize - ((expectedParts - 1) * VIDEO_PART_BYTES) : VIDEO_PART_BYTES;
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength && declaredLength !== expectedPartSize) return json({ error: "Part size does not match declared file size" }, 413);
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength !== expectedPartSize) return json({ error: "Part size does not match declared file size" }, 413);
  const bucket = multipartBucket(kind, env, key);
  if (!bucket) return json({ error: "Video storage binding is not configured" }, 503);
  try {
    const upload = bucket.resumeMultipartUpload(key, uploadId);
    const part = await upload.uploadPart(partNumber, buffer);
    return json({ ok: true, partNumber: part.partNumber, etag: part.etag });
  } catch (error) {
    console.error("Multipart part upload failed:", error);
    return json({ error: "Could not upload this video part" }, 400);
  }
}

async function completeVideoMultipart(request, env, user, url, kind) {
  const body = await request.json().catch(() => null);
  const key = body?.key;
  const uploadId = body?.uploadId;
  const fileSize = Number(body?.fileSize);
  const parts = body?.parts;
  if (!validateMultipartOwnership(key, uploadId, user, kind)) return json({ error: "Invalid upload ownership" }, 403);
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > MAX_VIDEO_BYTES) return json({ error: "Invalid video size" }, 400);
  const expectedParts = Math.ceil(fileSize / VIDEO_PART_BYTES);
  if (!Array.isArray(parts) || parts.length !== expectedParts) return json({ error: "Some video parts are missing" }, 400);
  const normalized = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const partNumber = Number(part?.partNumber);
    const etag = String(part?.etag || "");
    if (partNumber !== index + 1 || !etag || etag.length > 256) return json({ error: "Invalid multipart part list" }, 400);
    normalized.push({ partNumber, etag });
  }
  const bucket = multipartBucket(kind, env, key);
  if (!bucket) return json({ error: "Video storage binding is not configured" }, 503);
  try {
    const upload = bucket.resumeMultipartUpload(key, uploadId);
    const completed = await upload.complete(normalized);
    const saved = await bucket.head(key);
    if (!saved || saved.size !== fileSize || saved.customMetadata?.owner !== user.id) {
      console.error("Multipart object verification failed", { key, expected: fileSize, actual: saved?.size });
      return json({ error: "Uploaded video verification failed; original object was retained" }, 500);
    }
    const videoUrl = `${url.origin}/media/${key}`;
    // Variants are playback derivatives, not independent published videos.
    if (key.startsWith("videos/") || key.startsWith("reels/")) {
      const sql = neon(env.NEON_DATABASE_URL);
      try {
        const caption = String(body.caption || saved.customMetadata?.caption || "").slice(0, 2000);
        const rows = await sql`
          INSERT INTO reels (user_id, video_url, caption)
          VALUES (${user.id}, ${videoUrl}, ${caption})
          RETURNING id, user_id, video_url, thumbnail_url, caption, created_at
        `;
        return json({ ok: true, reel: rows[0], video: rows[0], url: videoUrl, size: completed.size, shareUrl: `${url.origin}/reels/?reel=${encodeURIComponent(rows[0].id)}` }, 201);
      } catch (error) {
        console.error("Unified video record creation failed; uploaded object retained for safety:", error);
        return json({ error: `Video uploaded but Neon record creation failed: ${String(error?.message || error).slice(0, 500)}`, key, url: videoUrl }, 500);
      }
    }
    return json({ ok: true, key, size: saved.size, url: videoUrl }, 201);
  } catch (error) {
    console.error("Multipart completion failed:", error);
    return json({ error: "Could not complete video upload" }, 400);
  }
}

async function abortVideoMultipart(request, env, user, url, kind) {
  const key = url.searchParams.get("key");
  const uploadId = url.searchParams.get("uploadId");
  if (!validateMultipartOwnership(key, uploadId, user, kind)) return json({ error: "Invalid upload ownership" }, 403);
  const bucket = multipartBucket(kind, env, key);
  if (!bucket) return json({ error: "Video storage binding is not configured" }, 503);
  try {
    await bucket.resumeMultipartUpload(key, uploadId).abort();
    return json({ ok: true, aborted: true });
  } catch (error) {
    console.warn("Multipart abort could not be confirmed:", error);
    return json({ error: "Could not abort multipart upload" }, 400);
  }
}

async function routeVideoMultipart(request, env, user, url, path, kind) {
  const base = kind === "reels" ? "/reels/multipart" : "/media/multipart";
  if (path === `${base}/init` && request.method === "POST") return initVideoMultipart(request, env, user, url, kind);
  if (path === `${base}/part` && request.method === "PUT") return uploadVideoPart(request, env, user, url, kind);
  if (path === `${base}/complete` && request.method === "POST") return completeVideoMultipart(request, env, user, url, kind);
  if (path === `${base}/abort` && request.method === "DELETE") return abortVideoMultipart(request, env, user, url, kind);
  return null;
}


async function variantManifestKey(sourceKey) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sourceKey));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const owner = sourceKey.split("/")[0];
  return `${owner}/variants/${hex}.json`;
}

async function handleVariantManifest(request, env, user, url) {
  const requestBody = request.method === "POST" ? await request.json().catch(() => null) : null;
  const sourceKey = request.method === "GET"
    ? String(url.searchParams.get("sourceKey") || "")
    : String(requestBody?.sourceKey || "");
  if (!isSafeObjectKey(sourceKey) || !/^[0-9a-f-]{20,40}\/posts\//i.test(sourceKey)) {
    return json({ error: "Invalid source media key" }, 400);
  }
  const bucket = env.MEDIA_BUCKET;
  if (!bucket) return json({ error: "Storage binding is not configured" }, 503);
  const manifestKey = await variantManifestKey(sourceKey);

  if (request.method === "GET") {
    const manifest = await bucket.get(manifestKey);
    if (!manifest) return json({ ready: false, variants: [] }, 200, { "Cache-Control": "no-store" });
    const body = await manifest.json().catch(() => null);
    if (!body || body.sourceKey !== sourceKey || !Array.isArray(body.variants)) return json({ error: "Invalid variant manifest" }, 500);
    return json({ ready: true, variants: body.variants }, 200, { "Cache-Control": "public, max-age=60" });
  }

  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!sourceKey.startsWith(`${user.id}/posts/`)) return json({ error: "Source ownership mismatch" }, 403);
  const source = await bucket.head(sourceKey);
  if (!source || source.customMetadata?.owner !== user.id) return json({ error: "Original video ownership could not be verified" }, 403);
  const variants = requestBody?.variants;
  if (!Array.isArray(variants) || variants.length < 1 || variants.length > 3) return json({ error: "Invalid variants list" }, 400);
  const normalized = [];
  const seen = new Set();
  for (const item of variants) {
    const quality = Number(item?.quality);
    const key = String(item?.key || "");
    if (![360, 480, 720].includes(quality) || seen.has(quality) || !key.startsWith(`${user.id}/variants/`) || !isSafeObjectKey(key)) {
      return json({ error: "Invalid variant entry" }, 400);
    }
    const object = await bucket.head(key);
    if (!object || object.customMetadata?.owner !== user.id || object.customMetadata?.folder !== "variants") {
      return json({ error: "Variant ownership could not be verified" }, 403);
    }
    seen.add(quality);
    normalized.push({ quality, key, url: `${url.origin}/media/${key}`, size: object.size });
  }
  normalized.sort((a, b) => a.quality - b.quality);
  const document = { sourceKey, variants: normalized, updatedAt: new Date().toISOString() };
  await bucket.put(manifestKey, JSON.stringify(document), {
    httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "public, max-age=60" },
    customMetadata: { owner: user.id, sourceKey, type: "video-variants-manifest" },
  });
  return json({ ok: true, ready: true, variants: normalized }, 201);
}

async function getSupabaseVisiblePostIds(postIds, env, authorization) {
  const ids = [...new Set((Array.isArray(postIds) ? postIds : []).map(String)
    .filter(id => /^[A-Za-z0-9_-]{1,128}$/.test(id)))];
  if (!ids.length) return new Set();
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !authorization.startsWith("Bearer ")) {
    throw new Error("Supabase RLS catalog check is not configured");
  }
  const endpoint = new URL(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/posts`);
  endpoint.searchParams.set("select", "id");
  endpoint.searchParams.set("id", `in.(${ids.join(",")})`);
  const response = await fetch(endpoint.toString(), {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: authorization,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Supabase RLS catalog check failed (${response.status})`);
  const visibleRows = await response.json();
  if (!Array.isArray(visibleRows)) throw new Error("Unexpected Supabase RLS catalog response");
  return new Set(visibleRows.map(row => String(row?.id || "")).filter(Boolean));
}

async function getSupabaseVisiblePostOwners(postIds, env, authorization) {
  const ids = [...new Set((Array.isArray(postIds) ? postIds : []).map(String)
    .filter(id => /^[A-Za-z0-9_-]{1,128}$/.test(id)))];
  if (!ids.length) return new Map();
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !authorization.startsWith("Bearer ")) {
    throw new Error("Supabase RLS post-owner check is not configured");
  }
  const endpoint = new URL(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/posts`);
  endpoint.searchParams.set("select", "id,user_id");
  endpoint.searchParams.set("id", `in.(${ids.join(",")})`);
  const response = await fetch(endpoint.toString(), {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: authorization,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Supabase RLS post-owner check failed (${response.status})`);
  const visibleRows = await response.json();
  if (!Array.isArray(visibleRows)) throw new Error("Unexpected Supabase RLS post-owner response");
  return new Map(visibleRows
    .filter(row => row?.id && row?.user_id)
    .map(row => [String(row.id), String(row.user_id)]));
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/hovod/playback/ticket" && request.method === "POST") {
        return handleHovodTicket(request, env);
      }
      if (path === "/hovod/playback/refresh" && request.method === "POST") {
        return handleHovodRefresh(request, env);
      }

      if (path === "/" && request.method === "GET") {
        return json({
          ok: true,
          service: "egybook-media-api",
          mediaBucket: "egybook-media",
          reelsBucket: "egybook-reels",
        });
      }

      if (path === "/media/variants/manifest" && (request.method === "GET" || request.method === "POST")) {
        const manifestUser = request.method === "POST" ? await getUser(request, env) : null;
        if (request.method === "POST" && !manifestUser) return json({ error: "Unauthorized" }, 401);
        return handleVariantManifest(request, env, manifestUser, url);
      }

      if (path.startsWith("/media/") && (request.method === "GET" || request.method === "HEAD" || request.method === "DELETE")) {
        let key;
        try {
          key = decodeURIComponent(path.slice(7));
        } catch {
          return json({ error: "Invalid media key" }, 400);
        }
        if (request.method === "GET" || request.method === "HEAD") return serveMedia(key, env, request, request.method === "HEAD");

        const deletingUser = await getUser(request, env);
        if (!deletingUser) return json({ error: "Unauthorized" }, 401);
        return deleteMedia(key, env, deletingUser, request, url);
      }

      // The Reels catalog and single-Reel metadata can contain links to posts
      // with restricted audiences. Require a verified session for these reads;
      // linked post visibility is then checked through Supabase RLS below.
      const protectedReelRead = request.method === "GET" &&
        (path === "/reels" || /^\/reels\/\d+$/.test(path) || /^\/reels\/by-post\/[^/]+$/.test(path));
      const user = (request.method !== "GET" || protectedReelRead)
        ? await getUser(request, env)
        : null;
      if ((request.method !== "GET" || protectedReelRead) && !user) {
        return json({ error: "Unauthorized" }, 401, { "Cache-Control": "no-store" });
      }

      const mediaMultipart = await routeVideoMultipart(request, env, user, url, path, "media");
      if (mediaMultipart) return mediaMultipart;
      const reelsMultipart = await routeVideoMultipart(request, env, user, url, path, "reels");
      if (reelsMultipart) return reelsMultipart;

      if (path === "/media" && request.method === "POST") {
        return uploadMedia(request, env, user, url);
      }

      const sql = neon(env.NEON_DATABASE_URL);

      // Unified video view analytics. A view is scoped to the canonical Neon
      // video row linked to the source post; progress is upserted per viewer session.
      if (path === "/videos/views" && request.method === "GET") {
        const postId = String(url.searchParams.get("post_id") || "").trim();
        if (!postId || postId.length > 128) return json({ error: "Invalid post_id" }, 400);
        const rows = await sql`
          SELECT r.id AS video_id, COUNT(v.session_id)::int AS view_count,
            CASE WHEN COUNT(v.session_id) = 0 THEN 0
              ELSE ROUND(AVG(CASE WHEN v.duration_seconds > 0
                THEN LEAST(100, GREATEST(0, v.watched_seconds / v.duration_seconds * 100))
                ELSE NULL END)::numeric, 2) END AS avg_completion_percent
          FROM reel_post_links l
          JOIN reels r ON r.id = l.reel_id
          LEFT JOIN reel_video_views v ON v.reel_id = r.id
          WHERE l.post_id = ${postId}
          GROUP BY r.id ORDER BY r.id DESC LIMIT 1
        `;
        return json({ post_id: postId, view_count: Number(rows[0]?.view_count || 0),
          avg_completion_percent: rows[0]?.avg_completion_percent == null ? null : Number(rows[0].avg_completion_percent),
          video_id: rows[0]?.video_id ?? null }, 200, { "Cache-Control": "no-store" });
      }
      if (path === "/videos/views" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        const postId = String(body?.post_id || "").trim();
        const sessionId = String(body?.session_id || "").trim();
        const watched = Number(body?.watched_seconds);
        const duration = Number(body?.duration_seconds);
        if (!postId || postId.length > 128 || !/^[0-9a-f-]{36}$/i.test(sessionId) ||
            !Number.isFinite(watched) || watched < 0 || watched > 86400 ||
            !Number.isFinite(duration) || duration < 0 || duration > 86400) {
          return json({ error: "Invalid video view payload" }, 400);
        }
        const linked = await sql`SELECT reel_id FROM reel_post_links WHERE post_id = ${postId} AND user_id = ${user.id} LIMIT 1`;
        // A post can be public while its view is recorded by any authenticated viewer.
        const target = linked.length ? linked[0] : (await sql`SELECT reel_id FROM reel_post_links WHERE post_id = ${postId} LIMIT 1`)[0];
        if (!target) return json({ error: "Video is not linked to a Neon record" }, 404);
        const rows = await sql`
          INSERT INTO reel_video_views (reel_id, viewer_user_id, session_id, watched_seconds, duration_seconds)
          VALUES (${target.reel_id}, ${user.id}, ${sessionId}, ${watched}, ${duration > 0 ? duration : null})
          ON CONFLICT (reel_id, viewer_user_id, session_id) DO UPDATE SET
            watched_seconds = GREATEST(reel_video_views.watched_seconds, EXCLUDED.watched_seconds),
            duration_seconds = COALESCE(EXCLUDED.duration_seconds, reel_video_views.duration_seconds),
            updated_at = now()
          RETURNING (xmax = 0) AS inserted
        `;
        return json({ ok: true, inserted: !!rows[0]?.inserted }, 200, { "Cache-Control": "no-store" });
      }

      // Stable bridge between the existing Supabase post row and its Neon reel row.
      const postLink = path.match(/^\/reels\/by-post\/([^/]+)$/);
      if (postLink && request.method === "GET") {
        let postId = "";
        try { postId = decodeURIComponent(postLink[1]).trim(); } catch { return json({ error: "Invalid post id" }, 400); }
        if (!postId || postId.length > 128) return json({ error: "Invalid post id" }, 400);

        // A Realtime post INSERT can arrive before the publishing account has
        // committed its Neon reel_post_links row. This read-only lookup lets a
        // viewer reconcile that single post without refetching the whole catalog.
        // Check Supabase RLS before returning any Neon media URL.
        const visiblePostOwners = await getSupabaseVisiblePostOwners(
          [postId], env, request.headers.get("Authorization") || ""
        );
        const postOwnerId = visiblePostOwners.get(postId);
        if (!postOwnerId) {
          return json({ error: "POST_NOT_VISIBLE" }, 404, { "Cache-Control": "no-store" });
        }
        const linkedRows = await sql`
          SELECT r.id, r.user_id, r.video_url, r.thumbnail_url, r.caption, r.created_at,
            l.post_id
          FROM reel_post_links l
          JOIN reels r ON r.id = l.reel_id
          WHERE l.post_id = ${postId} AND r.user_id = ${postOwnerId} AND l.user_id = ${postOwnerId}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 10
        `;
        return json({ reels: linkedRows }, 200, { "Cache-Control": "no-store" });
      }
      if (postLink && request.method === "POST") {
        const postId = decodeURIComponent(postLink[1]).trim();
        const body = await request.json().catch(() => ({}));
        const videoIds = Array.isArray(body.reel_ids) ? [...new Set(body.reel_ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 10) : [];
        if (!postId || postId.length > 128) return json({ error: "Invalid post id" }, 400);
        if (videoIds.length) {
          const owned = await sql`SELECT id FROM reels WHERE id = ANY(${videoIds}) AND user_id = ${user.id}`;
          if (owned.length !== videoIds.length) return json({ error: "One or more video records are not owned by this user" }, 403);
          for (const videoId of videoIds) {
            await sql`INSERT INTO reel_post_links (post_id, reel_id, user_id) VALUES (${postId}, ${videoId}, ${user.id}) ON CONFLICT (post_id, reel_id) DO NOTHING`;
          }
          return json({ linked: true, post_id: postId, reel_ids: videoIds }, 201);
        }
        // Existing feed cards resolve their canonical Neon row by post/video link.
        // Never create a duplicate row just because comments are opened after reload.
        const requestedVideoUrl = String(body.video_url || "").trim().slice(0, 2048);
        const existing = await sql`
          SELECT r.id, r.user_id, r.video_url, r.thumbnail_url, r.caption, r.created_at
          FROM reel_post_links l JOIN reels r ON r.id = l.reel_id
          WHERE l.post_id = ${postId} AND l.user_id = ${user.id}
            AND (${requestedVideoUrl} = '' OR r.video_url = ${requestedVideoUrl})
          ORDER BY r.created_at DESC LIMIT 1
        `;
        if (existing.length) return json({ reel: existing[0], linked: true, existing: true }, 200);
        const videoUrl = String(body.video_url || "").trim().slice(0, 2048);
        const caption = String(body.caption || "").slice(0, 2000);
        const thumbnailUrl = String(body.thumbnail_url || "").trim().slice(0, 2048) || null;
        if (!/^https?:\/\//i.test(videoUrl)) return json({ error: "Invalid video URL" }, 400);
        const created = await sql`INSERT INTO reels (user_id, video_url, thumbnail_url, caption) VALUES (${user.id}, ${videoUrl}, ${thumbnailUrl}, ${caption}) RETURNING id, user_id, video_url, thumbnail_url, caption, created_at`;
        await sql`INSERT INTO reel_post_links (post_id, reel_id, user_id) VALUES (${postId}, ${created[0].id}, ${user.id}) ON CONFLICT (post_id, reel_id) DO NOTHING`;
        return json({ reel: created[0], linked: true }, 201);
      }

      if (path === "/reels" && request.method === "GET") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 50);
        const offset = Math.max(0, Math.min(Number(url.searchParams.get("offset") || 0), 1000000));
        const rows = await sql`
          -- Catalog pagination remains ordered by creation time. Linked rows are
          -- filtered against the current viewer's Supabase RLS visibility before
          -- any media URL is returned to the browser.
          SELECT r.id, r.user_id, r.video_url, r.thumbnail_url, r.caption, r.created_at,
            l.post_id
          FROM reels r
          LEFT JOIN reel_post_links l ON l.reel_id = r.id
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT ${limit + 1} OFFSET ${offset}
        `;
        const pageRows = rows.slice(0, limit);
        const linkedPostIds = [...new Set(pageRows.map(row => String(row.post_id || "")).filter(Boolean))];
        const visiblePostIds = await getSupabaseVisiblePostIds(
          linkedPostIds, env, request.headers.get("Authorization") || ""
        );
        const visibleRows = filterReelCatalogRowsForViewer(pageRows, visiblePostIds);
        const hasMore = rows.length > limit;
        return json({ reels: visibleRows, has_more: hasMore, next_offset: offset + Math.min(rows.length, limit) }, 200, { "Cache-Control": "no-store" });
      }

      const reelById = path.match(/^\/reels\/(\d+)$/);
      if (reelById && request.method === "GET") {
        const rows = await sql`
          SELECT r.id, r.user_id, r.video_url, r.thumbnail_url, r.caption, r.created_at, l.post_id,
            (SELECT COUNT(*)::int FROM reel_likes lk WHERE lk.reel_id = r.id) AS likes_count,
            (SELECT COUNT(*)::int FROM reel_comments c WHERE c.reel_id = r.id) AS comments_count,
            (SELECT COUNT(*)::int FROM reel_shares sh WHERE sh.reel_id = r.id) AS shares_count
          FROM reels r LEFT JOIN reel_post_links l ON l.reel_id = r.id
          WHERE r.id = ${Number(reelById[1])} LIMIT 1
        `;
        if (!rows.length) return json({ error: "Video not found" }, 404);
        if (rows[0].post_id) {
          const visiblePostIds = await getSupabaseVisiblePostIds(
            [String(rows[0].post_id)], env, request.headers.get("Authorization") || ""
          );
          if (!visiblePostIds.has(String(rows[0].post_id))) {
            return json({ error: "Video not found" }, 404, { "Cache-Control": "no-store" });
          }
        }
        return json({ reel: rows[0] }, 200, { "Cache-Control": "no-store" });
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
        const reelId = Number(like[1]);
        const rows = await sql`
          INSERT INTO reel_likes (reel_id, user_id)
          VALUES (${reelId}, ${user.id})
          ON CONFLICT (reel_id, user_id) DO NOTHING
          RETURNING id
        `;
        // The Neon AFTER INSERT trigger has already committed the outbox row
        // in the same transaction as the like. Drain immediately, with Cron as fallback.
        await deliverQueuedReelNotifications(env);
        return json({ liked: true, created: rows.length > 0 });
      }
      if (like && request.method === "DELETE") {
        await sql`
          DELETE FROM reel_likes
          WHERE reel_id = ${Number(like[1])} AND user_id = ${user.id}
        `;
        return json({ liked: false });
      }

      // A share is counted only after the native share sheet or link-copy flow
      // completes successfully. event_id makes safe retries idempotent.
      const share = path.match(/^\/reels\/(\d+)\/share$/);
      if (share && request.method === "POST") {
        const reelId = Number(share[1]);
        const body = await request.json().catch(() => ({}));
        const eventId = String(body?.event_id || '').trim();
        if (!Number.isSafeInteger(reelId) || reelId < 1 || !/^[A-Za-z0-9_-]{8,80}$/.test(eventId)) {
          return json({ error: "Invalid share event" }, 400);
        }
        const reel = await sql`SELECT id FROM reels WHERE id = ${reelId} LIMIT 1`;
        if (!reel.length) return json({ error: "Video not found" }, 404);
        const inserted = await sql`
          INSERT INTO reel_shares (reel_id, user_id, event_id)
          VALUES (${reelId}, ${user.id}, ${eventId})
          ON CONFLICT (reel_id, event_id) DO NOTHING
          RETURNING id
        `;
        const totals = await sql`SELECT COUNT(*)::int AS shares_count FROM reel_shares WHERE reel_id = ${reelId}`;
        return json({ shared: true, created: inserted.length > 0, shares_count: Number(totals[0]?.shares_count || 0) }, 200, { "Cache-Control": "no-store" });
      }

      const comments = path.match(/^\/reels\/(\d+)\/comments$/);
      if (comments && request.method === "GET") {
        const reelId = Number(comments[1]);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 30), 1), 50);
        const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
        const sort = url.searchParams.get("sort") === "relevant" ? "relevant" : "recent";
        // Paginate only top-level comments. Replies are fetched recursively for
        // the selected roots so a page boundary can never detach a reply from
        // its parent or make it disappear from the thread.
        const roots = sort === "relevant" ? await sql`
          SELECT c.id, c.reel_id, c.user_id, c.comment_text, c.parent_comment_id,
                 c.created_at, c.edited_at,
                 (SELECT COUNT(*)::int FROM reel_comments r WHERE r.parent_comment_id=c.id) AS replies_count,
                 (SELECT COUNT(*)::int FROM reel_comment_reactions x WHERE x.comment_id=c.id) AS reactions_count
          FROM reel_comments c
          WHERE c.reel_id=${reelId} AND c.parent_comment_id IS NULL
          ORDER BY (SELECT COUNT(*) FROM reel_comment_reactions x WHERE x.comment_id=c.id) DESC,
                   (SELECT COUNT(*) FROM reel_comments r WHERE r.parent_comment_id=c.id) DESC,
                   c.created_at DESC, c.id DESC LIMIT ${limit} OFFSET ${offset}
        ` : await sql`
          SELECT c.id, c.reel_id, c.user_id, c.comment_text, c.parent_comment_id,
                 c.created_at, c.edited_at,
                 (SELECT COUNT(*)::int FROM reel_comments r WHERE r.parent_comment_id=c.id) AS replies_count,
                 (SELECT COUNT(*)::int FROM reel_comment_reactions x WHERE x.comment_id=c.id) AS reactions_count
          FROM reel_comments c
          WHERE c.reel_id=${reelId} AND c.parent_comment_id IS NULL
          ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit} OFFSET ${offset}
        `;
        const rootIds = roots.map(r => String(r.id));
        const totalRows = offset === 0 ? await sql`
          SELECT COUNT(*)::int AS total_count FROM reel_comments WHERE reel_id=${reelId}
        ` : [];
        const replies = rootIds.length ? await sql`
          WITH RECURSIVE comment_tree AS (
            SELECT c.id, c.reel_id, c.user_id, c.comment_text, c.parent_comment_id, c.created_at, c.edited_at
            FROM reel_comments c
            WHERE c.reel_id=${reelId} AND c.parent_comment_id = ANY(${rootIds}::bigint[])
            UNION ALL
            SELECT child.id, child.reel_id, child.user_id, child.comment_text, child.parent_comment_id, child.created_at, child.edited_at
            FROM reel_comments child
            INNER JOIN comment_tree parent ON child.parent_comment_id = parent.id
            WHERE child.reel_id=${reelId}
          )
          SELECT id, reel_id, user_id, comment_text, parent_comment_id, created_at, edited_at
          FROM comment_tree ORDER BY created_at ASC, id ASC
        ` : [];
        const rows = [...roots, ...replies];
        const ids = rows.map(r => String(r.id));
        const reactions = ids.length ? await sql`
          SELECT comment_id, user_id, reaction FROM reel_comment_reactions
          WHERE comment_id = ANY(${ids}::bigint[])
        ` : [];
        const mine = reactions.filter(r => r.user_id === (user?.id || ""));
        return json({
          comments: rows, reactions, my_reactions: mine, limit, offset, sort,
          roots_count: roots.length, total_count: totalRows.length ? Number(totalRows[0].total_count) : null, has_more: roots.length === limit
        }, 200, { "Cache-Control": "no-store" });
      }
      if (comments && request.method === "POST") {
        const reelId = Number(comments[1]);
        const body = await request.json().catch(() => ({}));
        const text = String(body.comment_text || "").trim().slice(0, 2000);
        const parentId = body.parent_comment_id == null ? null : Number(body.parent_comment_id);
        if (!text) return json({ error: "Comment cannot be empty" }, 400);
        if (parentId && (!Number.isSafeInteger(parentId) || parentId < 1)) return json({ error: "Invalid parent comment" }, 400);
        if (parentId) {
          const parent = await sql`SELECT id, reel_id, user_id FROM reel_comments WHERE id=${parentId} LIMIT 1`;
          if (!parent.length || Number(parent[0].reel_id) !== reelId) return json({ error: "Parent comment not found" }, 404);
        }
        const rows = await sql`
          INSERT INTO reel_comments (reel_id, user_id, comment_text, parent_comment_id)
          VALUES (${reelId}, ${user.id}, ${text}, ${parentId})
          RETURNING id, reel_id, user_id, comment_text, parent_comment_id, created_at, edited_at
        `;
        const savedComment = rows[0];
        // Neon AFTER INSERT trigger wrote owner/reply notifications to the outbox atomically.
        await deliverQueuedReelNotifications(env);
        return json({ comment: savedComment }, 201);
      }

      const commentItem = path.match(/^\/reels\/(\d+)\/comments\/(\d+)$/);
      if (commentItem && request.method === "PATCH") {
        const reelId=Number(commentItem[1]), commentId=Number(commentItem[2]);
        const body=await request.json().catch(()=>({}));
        const text=String(body.comment_text||"").trim().slice(0,2000);
        if(!text) return json({error:"Comment cannot be empty"},400);
        const rows=await sql`
          UPDATE reel_comments c SET comment_text=${text}, edited_at=now()
          WHERE c.id=${commentId} AND c.reel_id=${reelId} AND c.user_id=${user.id}
          RETURNING c.id,c.reel_id,c.user_id,c.comment_text,c.parent_comment_id,c.created_at,c.edited_at
        `;
        if(!rows.length) return json({error:"Comment not found or not owned by user"},404);
        return json({comment:rows[0]});
      }
      if (commentItem && request.method === "DELETE") {
        const reelId=Number(commentItem[1]), commentId=Number(commentItem[2]);
        const reel=await sql`SELECT user_id FROM reels WHERE id=${reelId} LIMIT 1`;
        const rows=await sql`
          DELETE FROM reel_comments c WHERE c.id=${commentId} AND c.reel_id=${reelId}
            AND (c.user_id=${user.id} OR ${reel[0]?.user_id || ""}=${user.id})
          RETURNING c.id
        `;
        if(!rows.length) return json({error:"Comment not found or delete not permitted"},404);
        return json({deleted:true,id:commentId});
      }

      const commentReactions=path.match(/^\/reels\/(\d+)\/comments\/(\d+)\/reactions$/);
      if(commentReactions && (request.method === "POST" || request.method === "DELETE")) {
        const reelId=Number(commentReactions[1]), commentId=Number(commentReactions[2]);
        const target=await sql`SELECT id,user_id FROM reel_comments WHERE id=${commentId} AND reel_id=${reelId} LIMIT 1`;
        if(!target.length) return json({error:"Comment not found"},404);
        if(request.method === "DELETE") {
          await sql`DELETE FROM reel_comment_reactions WHERE comment_id=${commentId} AND user_id=${user.id}`;
          return json({reacted:false});
        }
        const body=await request.json().catch(()=>({}));
        const reaction=String(body.reaction||"");
        if(!["👍","👎","❤️","😍","😂","😮","😢","😡"].includes(reaction)) return json({error:"Invalid reaction"},400);
        const rows=await sql`
          INSERT INTO reel_comment_reactions (comment_id,user_id,reaction)
          VALUES (${commentId},${user.id},${reaction})
          ON CONFLICT (comment_id,user_id) DO UPDATE
            SET reaction=EXCLUDED.reaction,updated_at=now()
            WHERE reel_comment_reactions.reaction IS DISTINCT FROM EXCLUDED.reaction
          RETURNING comment_id,user_id,reaction,updated_at
        `;
        await deliverQueuedReelNotifications(env);
        return json({reacted:true,reaction:rows[0]||null,changed:rows.length>0});
      }

      const commentNotifs=path.match(/^\/reels\/(\d+)\/comment-notifications$/);
      if(commentNotifs && request.method === "GET") {
        if (!user) return json({error:"Unauthorized"},401);
        const limit=Math.min(Math.max(Number(url.searchParams.get("limit")||30),1),50);
        const rows=await sql`
          SELECT id,recipient_user_id,actor_user_id,reel_id,comment_id,notification_type,reaction,is_read,created_at
          FROM reel_comment_notifications WHERE recipient_user_id=${user.id}
          ORDER BY created_at DESC,id DESC LIMIT ${limit}
        `;
        return json({notifications:rows});
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error("EgyBook Media API:", error);
      return json({ error: "Internal server error" }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(deliverQueuedReelNotifications(env));
  },
};
