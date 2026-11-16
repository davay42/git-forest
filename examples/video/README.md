# video/ — Content-Addressed Video Streaming Demo

A self-contained component that turns a folder of files into a governed video library: chunked resumable uploads, content-addressed storage, signed streaming URLs, and an MD-LD knowledge graph as the source of truth.

## What This Demonstrates

### 1. Content-Addressed Storage
Every uploaded file is hashed (SHA-256, first 16 hex chars) and stored as `videos/{hash}.{ext}` — never by its original name. The hash *is* the identity: duplicate uploads are discarded, references are stable, and the librarian can verify integrity by re-hashing.

### 2. Chunked, Resumable Uploads
Large files cross the network as 2MB chunks through a session protocol:

- `POST /upload/start` → creates `uploads/{uploadId}/` with `meta.json`
- `POST /upload/{id}/chunk` → streams one chunk to disk (`X-Chunk-Index` header)
- `GET /upload/{id}/status` → reports received chunks so the client can resume
- `POST /upload/{id}/complete` → concatenates, re-hashes, dedups, registers in `library.md`

The browser keeps session state in `localStorage` (`forest:video:upload`), so a dropped connection or page reload resumes where it left off — with per-request retries and a 5-attempt backoff.

### 3. Signed URLs with Range Support
Videos are never served by hash alone. The watch and embed pages mint a time-limited token (`{hash}.{expires}.{hmac}`, 4h TTL, `VIDEO_SIGN_SECRET`), and `/stream/{hash}?token=…` validates it before serving. Streams support HTTP `Range` requests, `ETag`/`304`, and immutable caching — real `<video>` seeking works.

### 4. Admin Gating via the Knowledge Graph
Upload routes require `x-forest-user-id` to appear in the library's `video:hasAdmin` quads. No separate auth system — authorization is data, living in `library.md` itself.

### 5. The Librarian
On boot, the component reconciles `videos/` with `library.md`: it renames non-conforming files to `{hash}{ext}`, discovers untracked files and registers them as `Untitled` entries, and reports missing/corrupted assets. It also sweeps upload sessions idle for >24h.

### 6. Three Views, One Asset
- `/` — public library grid (upload button appears only for admins)
- `/watch/{hash}` — full player with signed stream URL and download link
- `/embed/{hash}` — minimal poster player for iframes; swaps in the video on click

## Usage

### Grant Admin
Add yourself to `library.md` (the `x-forest-user-id` is your user id from the forest's identity layer):

```md
[video] <tag:example.org,2026:video/>

# Video Library {=video:library .prov:Collection label}

[you] {+video:user/your-user-id ?video:hasAdmin}
```

### Configure
| Variable | Default | Purpose |
|----------|---------|---------|
| `VIDEO_SIGN_SECRET` | *(random per boot)* | HMAC key for stream tokens — set explicitly or signed URLs die on restart |
| `COMPONENT_NAME` | *(kernel-provided)* | URL path segment for API calls |

### Files
- `library.md` — committed Knowledge: the catalog and admin declarations
- `videos/` — Soil (gitignored): content-addressed video files
- `uploads/` — Soil (gitignored): transient chunk sessions, swept after 24h

## Adaptation Notes

- The namespace `tag:example.org,2026:video/` is arbitrary — change `VIDEO_BASE` in `index.js` and the `[video]` binding in `library.md`/`index.md` together.
- Admin checks are a simple IRI list; swap `getAdmins`/`requireAdmin` for your own authorization source if needed.
- The embed page falls back to a hash-derived SVG poster when a video has no `thumbnail` property.
