[video] <tag:example.org,2026:video/>
[gf] <https://github.com/davay42/git-forest/>

# Video Agent {=video:agent .prov:SoftwareAgent label}
> Manages content-addressed video assets, chunked resumable uploads, signed streaming URLs, and admin-controlled publishing. {comment}

The Video Agent is the sovereign custodian of all video files in the forest. It stores files by content hash (never by name), accepts large uploads as 2MB chunks with resume support, issues time-limited signed URLs for streaming, reconciles the filesystem with its knowledge graph on boot, and renders three distinct views of each asset (library, player, embed). Only users explicitly granted admin privileges via `video:hasAdmin` in `library.md` may add new videos; everyone else can only watch via signed URLs the content agent embeds.

## Narrative

[video] {=video:agent} wakes up and immediately [runs the librarian] {+video:runLibrarian ?prov:hadRole} to reconcile the `videos/` directory with its knowledge graph, ensuring every file on disk has a corresponding entry in `library.md` and vice versa, and [sweeps stale upload sessions] {+video:sweepUploads ?prov:hadRole} older than 24 hours. When an admin visits the root, they see the [rendered library] {+video:renderLibrary ?prov:hadRole} — a grid of all tracked videos with a conditional upload button. If they click upload, the agent [renders the upload page] {+video:renderUploadPage ?prov:hadRole} with a chunked, resumable upload script. The browser then [starts an upload session] {+video:startUpload ?prov:hadRole}, [streams chunks] {+video:receiveChunk ?prov:hadRole} (querying [upload status] {+video:uploadStatus ?prov:hadRole} to resume after drops), and [completes the upload] {+video:completeUpload ?prov:hadRole} by concatenating, hashing, deduplicating, and registering the video. When a visitor clicks a video card, the agent [renders the watch page] {+video:renderWatchPage ?prov:hadRole} with a full-featured player and download link. When the content agent embeds a video in an iframe, the video agent [renders the embed page] {+video:renderEmbedPage ?prov:hadRole} — a minimal poster player that loads the video on click. In both cases, when the browser requests the actual video bytes, the agent [streams the video] {+video:streamVideo ?prov:hadRole}, validating the signed token and serving with HTTP range request support.

## Entities

### Video {=video:Video .rdfs:Class label}
> A content-addressed video file stored in the videos/ directory. {comment}
Identified by the first 16 hex characters of its SHA-256 hash. Filename is always `{hash}.{ext}`. Supported extensions: mp4, webm, ogg, mov, m4v.

### Library {=video:Library .prov:Collection label}
> The MD-LD knowledge graph of all tracked videos, stored in [./library.md](./library.md). {comment}

### Upload Session {=video:UploadSession .prov:Entity label}
> A transient chunked-upload staging area under `uploads/{uploadId}/` with `meta.json` and `chunk-NNNNNN` files. {comment}
Created by POST /upload/start, swept after 24h of inactivity, deleted on completion.

### Thumbnail {=video:Thumbnail .rdfs:Class label}
> An optional image asset associated with a video, used as embed poster. {comment}
Read from the video's `thumbnail` property — a local path or external URL. Falls back to a generated SVG (hash-derived hue, label, comment, hash).

### Has Thumbnail {=video:thumbnail .rdf:Property label}
> Links a video to its thumbnail image. {comment}
Domain: [Video] {+video:Video ?rdfs:domain}
Range: [Thumbnail] {+video:Thumbnail ?rdfs:range}

### Admin {=video:Admin .rdfs:Class label}
> A user account with permission to upload new videos. {comment}
Declared in [./library.md](./library.md): `video:hasAdmin` quads on the `video:library` subject, object IRIs ending in the user id.

## Roles

### Require Admin Role {=video:requireAdmin .prov:Role label}
> Gates every upload route: resolves x-forest-user-id and checks it against the library's hasAdmin list. {comment}

[Every /upload/* request] {gf:hasTrigger}
[./index.js#L71] {gf:hasPath}
[x-forest-user-id header, library.md contents] {gf:expectsInput}
[userId on success; 401 (no header) or 403 (not admin) response and null on failure] {gf:generatesOutput}
[User authenticated and listed in video:hasAdmin] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. Read x-forest-user-id; missing → 401
2. loadLibrary + getAdmins: quads on subject video/library with
   predicate video/hasAdmin; take last path segment of each object
3. userId not in admins → 403; else return userId
~~~~~~

### Render Library Role {=video:renderLibrary .prov:Role label}
> Renders the public video library page with all tracked videos as cards. {comment}

[GET /] {gf:hasTrigger}
[./index.js#L771] {gf:hasPath}
[x-forest-user-id header (optional, for admin detection)] {gf:expectsInput}
[HTML library page with video grid, conditional upload link, and raw MD-LD details] {gf:generatesOutput}
[Library file exists or can be created] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. loadLibrary (falls back to LIBRARY_PREFIX), render() it to HTML for the
   collapsible "Raw Library" details block
2. parseLibrary: collect video:Video subjects and their property quads
   (local-name keyed: hash, filename, fileSize, generatedAtTime, comment, thumbnail)
3. Sort by generatedAtTime descending
4. getAdmins + x-forest-user-id → isAdmin → conditional "📤 Upload" link
5. Render header, count, video cards linking to ./watch/{hash} (label,
   fileSize, date, hash, comment), empty state, raw MD-LD details
~~~~~~

### Render Upload Page Role {=video:renderUploadPage .prov:Role label}
> Renders the admin-only chunked-upload form with resume support. {comment}

[GET /upload/] {gf:hasTrigger}
[./index.js#L537] {gf:hasPath}
[x-forest-user-id header] {gf:expectsInput}
[HTML upload form: title, description, file input (video/*,.tar.gz,.zip), progress bar, chunk log] {gf:generatesOutput}
[Requesting user is an admin] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. requireAdmin(req, res) — abort on failure
2. Return form with title/description inputs and file picker
3. Embed chunked-upload script: 2MB chunks, sha256 fingerprint of head+tail
   MiB, localStorage session state ('forest:video:upload'), resume via
   /upload/{id}/status, 5-retry backoff per request, progress bar + chunk log,
   POST /upload/{id}/complete with {title, description}, redirect to ../
~~~~~~

### Start Upload Role {=video:startUpload .prov:Role label}
> Creates an upload session directory and returns its id plus received-chunk state. {comment}

[POST /upload/start] {gf:hasTrigger}
[./index.js#L225] {gf:hasPath}
[JSON body {size, chunksCount, filename, fingerprint}] {gf:expectsInput}
[JSON {uploadId, chunksReceived, chunkSize}] {gf:generatesOutput}
[Admin; all three required fields present] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. requireAdmin
2. Parse body; 400 when size/chunksCount/filename missing
3. uploadId = 16 hex chars (randomBytes(8)); mkdir uploads/{uploadId}
4. Write meta.json {uploadId, adminId, filename, size, chunksCount,
   fingerprint, createdAt, chunksReceived: []}
5. Return 200 {uploadId, chunksReceived: [], chunkSize: 2MB}
~~~~~~

### Receive Chunk Role {=video:receiveChunk .prov:Role label}
> Streams one 2MB chunk to disk and records its index in session metadata. {comment}

[POST /upload/{uploadId}/chunk with X-Chunk-Index header] {gf:hasTrigger}
[./index.js#L269] {gf:hasPath}
[Request body = raw chunk bytes, x-forest-user-id, X-Chunk-Index] {gf:expectsInput}
[chunk-{index:06d} file in session dir, updated meta.json, JSON {ok, index}] {gf:generatesOutput}
[Session exists; requester is an admin AND the session owner (meta.adminId match); chunkIndex within chunksCount] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. 404 when meta.json missing; 401 without x-forest-user-id; 400 without X-Chunk-Index
2. Pipe request body to uploads/{id}/chunk-NNNNNN
3. Read meta.json, append index to chunksReceived (deduped, sorted), rewrite
4. Return 200 {ok: true, index}
~~~~~~

### Upload Status Role {=video:uploadStatus .prov:Role label}
> Reports which chunks a session has received, enabling client-side resume. {comment}

[GET /upload/{uploadId}/status] {gf:hasTrigger}
[./index.js#L315] {gf:hasPath}
[uploadId from URL] {gf:expectsInput}
[JSON {uploadId, chunksReceived, chunksCount, size, filename}] {gf:generatesOutput}
[Admin and session owner (meta.adminId === userId)] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. requireAdmin; 404 when session missing
2. 403 when meta.adminId !== requesting userId ("Not your session")
3. Return session progress fields as JSON
~~~~~~

### Complete Upload Role {=video:completeUpload .prov:Role label}
> Concatenates chunks, verifies the hash, deduplicates, and registers the video in library.md. {comment}

[POST /upload/{uploadId}/complete with JSON {title?, description?, hash?}] {gf:hasTrigger}
[./index.js#L342] {gf:hasPath}
[Session metadata, chunk files, optional client hash for verification] {gf:expectsInput}
[Video at videos/{hash}{ext}, appended video:Video entry in library.md, JSON {hash, title, size}] {gf:generatesOutput}
[Admin session owner; all chunks received] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. requireAdmin; 404 when session missing; 403 when not session owner
2. Verify every chunk 0..chunksCount-1 is in chunksReceived; 400 {missing}
3. Concatenate chunks in order into videos/temp-{uploadId}{ext} while
   computing SHA-256 incrementally; finalHash = first 16 hex chars
4. If client hash provided and mismatches → delete temp, 400 {expected, actual}
5. Dedup: if videos/{finalHash}{ext} exists, discard temp; else atomic rename
6. rm session dir; append library entry: `## {title} {=video:{hash} .video:Video label}`
   with video:hash, video:filename, video:fileSize ("N.NMB"), prov:generatedAtTime
   (xsd:date), optional comment; title defaults to filename sans extension
7. Return 200 {hash, title, size}
~~~~~~

### Stream Video Role {=video:streamVideo .prov:Role label}
> Serves video bytes with signed URL validation, ETag/304, and HTTP range support. {comment}

[GET /stream/{hash}?token=...] {gf:hasTrigger}
[./index.js#L450] {gf:hasPath}
[token query param, optional Range and If-None-Match headers] {gf:expectsInput}
[Video bytes (200/206/304/416), ETag, Accept-Ranges, immutable Cache-Control] {gf:generatesOutput}
[Valid, non-expired signed token matching the path hash] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. token = ?token=; missing → 403 "Signed URL required"
2. verifyVideoToken: split hash.expires.signature; reject when expired;
   expected = HMAC-SHA256(`${hash}.${expires}`, VIDEO_SIGN_SECRET) first 16
   hex chars, plain string equality; must also equal the path hash → 403
3. parseLibrary lookup by hash; unknown → 404; missing file on disk → 404
4. ETag = "{hash}-{size}"; If-None-Match match → 304
5. Range header: parse bytes=start-end, 416 with Content-Range */size on bad
   bounds; else 206 + Content-Range + partial createReadStream
6. No range → 200 full stream; both set Content-Type from extension MIME,
   Accept-Ranges: bytes, Cache-Control: public, max-age=31536000, immutable
~~~~~~

### Render Watch Page Role {=video:renderWatchPage .prov:Role label}
> Renders the full-featured video player page with signed stream URL and download link. {comment}

[GET /watch/{hash}] {gf:hasTrigger}
[./index.js#L833] {gf:hasPath}
[URL path parameter (hash)] {gf:expectsInput}
[HTML player page with <video/> element, signed stream URL, download link, metadata] {gf:generatesOutput}
[Video hash exists in library] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. parseLibrary, find video by hash; 404 when absent
2. signVideoUrl: token = {hash}.{expires}.{sig}, expires = now + 4h,
   sig = HMAC-SHA256 first 16 hex chars
3. Render page: autoplay <video> with ../stream/{hash}?token=..., title,
   fileSize/date/hash/comment metadata, download link (same URL +
   download="{label}{ext}"), token-expiry notice
~~~~~~

### Render Embed Page Role {=video:renderEmbedPage .prov:Role label}
> Renders a minimal iframe-friendly poster player that swaps in the video on click. {comment}

[GET /embed/{hash}] {gf:hasTrigger}
[./index.js#L878] {gf:hasPath}
[URL path parameter (hash)] {gf:expectsInput}
[Black full-viewport page: poster div + play button, click → <video> with signed URL] {gf:generatesOutput}
[Video hash exists in library] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. parseLibrary lookup; 404 when absent; fresh signed token
2. Poster = video.thumbnail, else data-URI SVG from generateFallbackSVG
   (hash-derived hue gradient, escaped label/comment, hash footer)
3. Render poster div with background-image and green circular play button
4. Click handler replaces body with autoplay <video> pointed at the signed stream URL
~~~~~~

### Run Librarian Role {=video:runLibrarian .prov:Role label}
> Scans videos/ on boot and reconciles it with library.md. {comment}

[Boot sequence, after library.md initialization] {gf:hasTrigger}
[./index.js#L136] {gf:hasPath}
[Filesystem state of videos/, current library.md contents] {gf:expectsInput}
[Renamed files, new video entries in library.md, console-logged missing/corrupted issues] {gf:generatesOutput}
[videos/ directory exists] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. readdir videos/, parseLibrary for known hashes
2. Per file: hashFile (SHA-256 stream, first 16 hex); expected name
   {hash}{ext} — rename when different
3. Unknown hash → new discovery
4. Per tracked video: missing file → 'missing' issue; re-hash mismatch →
   'corrupted' issue
5. Append "Untitled {hash8}" entries for discoveries: video:hash,
   video:filename, video:fileSize, prov:generatedAtTime (xsd:date),
   comment "Discovered by librarian"
6. Log summary counts
~~~~~~

### Sweep Stale Uploads Role {=video:sweepUploads .prov:Role label}
> Deletes upload session directories idle for more than 24 hours. {comment}

[Boot sequence] {gf:hasTrigger}
[./index.js#L203] {gf:hasPath}
[uploads/ directory entries and mtimes] {gf:expectsInput}
[Removed stale session dirs, cleanup log] {gf:generatesOutput}
[uploads/ may not exist] {gf:requiresPrerequisite}

~~~~~~md {+#plan .prov:Plan ?prov:hadPlan prov:value}
1. For each directory in uploads/: stat mtime
2. When now - mtime > 24h (SESSION_MAX_AGE_MS): rm -rf the session, count it
3. Log removals
~~~~~~

## Data File Shape: library.md

The `library.md` file is the persistent state of this agent. It begins with the Library declaration; admin grants and video entries are appended below:

```md
[video] <tag:example.org,2026:video/>

# Video Library {=video:library .prov:Collection label}

[example-admin] {+video:user/example-admin ?video:hasAdmin}

## Interval Studies {=video:a1b2c3d4e5f60718 .video:Video label}
[a1b2c3d4e5f60718] {video:hash}
[a1b2c3d4e5f60718.mp4] {video:filename}
[148.2MB] {video:fileSize}
[2026-01-15] {prov:generatedAtTime ^^xsd:date}
[Overview of just intervals] {comment}
```

Upload and librarian entries use `video:` predicates (hash, filename, fileSize, thumbnail) and xsd:date timestamps.

## Coordination

### Reads
- `./library.md` — the video catalog and admin declarations (video:hasAdmin)
- `./videos/{hash}{ext}` — the actual video files
- `x-forest-user-id` header — injected by kernel from device map

### Writes
- `./library.md` — appends video entries (upload complete, librarian discoveries)
- `./videos/{hash}{ext}` — stores uploaded video files (content-addressed, atomic rename)
- `./videos/temp-*` — transient concatenation staging during complete
- `./uploads/{uploadId}/` — chunk session dirs with meta.json + chunk files (swept after 24h)

### Sovereignty Boundary
- This agent owns everything in `video/`
- No other component writes to `library.md`, `videos/`, or `uploads/`
- The Content component references videos by hash via VideoAsset c:value but never reads or writes the video component's files
- Access control is internal: the Video agent checks admin status itself via `video:hasAdmin` in its own library; streaming is gated by signed URLs, not accounts

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `VIDEO_SIGN_SECRET` | *(random per boot)* | HMAC key for signed token generation/verification — no hardcoded default; set it explicitly or signed URLs die on restart |
| `COMPONENT_NAME` | *(kernel-provided)* | URL path segment for the upload page's API base |

Token TTL is hardcoded to 4 hours (`TOKEN_TTL_MS`); chunk size 2MB; upload sessions expire after 24h.

---

## The Agent's Philosophy

The Video Agent embodies one core principle: **content-addressed storage**. Files are identified by their content, not by their names — which makes the filesystem self-healing (the librarian can verify integrity by re-hashing) and every video referenceable from anywhere in the forest by a stable 16-character hash. The chunked upload protocol adds a second virtue: **resumability as a first-class citizen**. Large files cross unreliable networks as an acknowledged ledger of received chunks, so a dropped connection costs seconds, not the whole upload. The signed URL pattern adds temporal scoping: a video that exists forever on disk is only streamable for 4 hours at a time. Permanent storage, temporary access, resumable transfer — together they form the agent's identity.

🌲
