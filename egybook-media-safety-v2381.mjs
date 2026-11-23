/**
 * Pure policy helpers shared by the Cloudflare Worker and Node regression tests.
 * Keep media-bucket ownership consistent across upload, read, and delete paths.
 */
export function isUnifiedVideoObjectKey(key) {
  const value = String(key || '');
  return value.startsWith('reels/') || value.startsWith('videos/');
}

export function selectMediaBucketForKey(key, env) {
  return isUnifiedVideoObjectKey(key) ? env?.REELS_BUCKET : env?.MEDIA_BUCKET;
}

/**
 * Linked catalog rows are emitted only when the current viewer can read their
 * Supabase post under the same RLS rules used by the application. Legacy
 * unlinked rows remain public, matching the pre-existing standalone-Reel path.
 */
export function filterReelCatalogRowsForViewer(rows, visiblePostIds) {
  const visible = visiblePostIds instanceof Set
    ? visiblePostIds
    : new Set(Array.isArray(visiblePostIds) ? visiblePostIds.map(String) : []);
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const postId = String(row?.post_id || '').trim();
    return !postId || visible.has(postId);
  });
}
