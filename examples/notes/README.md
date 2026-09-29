# notes/ — Device Network Demo

A minimal demonstration of the **Forest Identity Protocol** patterns: device-first identity, arbitrary directed networks, and graph-based state management using MD-LD.

## What This Demonstrates

### 1. Device-First Identity
The Core provides every visitor with a cryptographic `x-forest-device-id` header. This component reads that header and maps it to a semantic entity (`link:Device`) in its local graph. No registration, no email, no password — just a device ID that persists via cookie.

### 2. Arbitrary Directed Networks
Devices can link to any number of other devices in any direction. The graph is a directed multigraph:
- A → B (A links to B)
- B → A (mutual link)
- A → B → C (chain)
- Cycles, stars, meshes — any topology

This models real-world scenarios:
- **Multi-device access**: Laptop → Phone → Tablet (one user, many devices)
- **Shared devices**: Family iPad → multiple student accounts
- **Collaborative clusters**: Team members linking devices for shared resources

### 3. Graph-Based State (MD-LD Soil)
All state lives in `devices.md` as Markdown-Linked Data:

```markdown
[link] <tag:school.example.org,2026:link/>

## ch {=link:device/62f983b0... .link:Device label}
[2026-09-29T09:19:40.640Z] {link:createdAt}
[vs] {+link:device/eec900b79a... ?link:linkedTo}

## ff {=link:device/905a86d514... .link:Device label}
[2026-09-29T09:19:50.766Z] {link:createdAt}
[ch] {+link:device/62f983b0d9... ?link:linkedTo}
[vs] {+link:device/eec900b79a... ?link:linkedTo}
```

**Key semantic choices:**
- `rdfs:label` for device names (standard RDF vocabulary)
- `link:linkedTo` as directed edges (outbound links)
- `link:createdAt` for provenance
- Full IRI linking via `{+link:device/... ?link:linkedTo}` syntax

The file is gitignored (Soil, not Knowledge). State persists on disk between restarts but isn't versioned.

### 4. Stateless Linking via Tokens
To link Device B to Device A:
1. Device A generates a signed token: `deviceId.exp.signature`
2. User copies token to Device B
3. Device B presents token → verified → `link:linkedTo` quad appended
4. Token expires after 1 hour

No database, no coordination, no centralized state. Pure cryptography.

## Usage

### Installation
```bash
# Ensure link/devices.md is in your .gitignore
echo "link/devices.md" >> .gitignore

# Restart the forest core to load the component
```

### Try It

1. **Visit `/link/`** on your laptop
   - Name it (e.g., "MacBook")
   - Copy the link token

2. **Open `/link/`** on your phone (or incognito window)
   - Name it (e.g., "iPhone")
   - Paste the token in "Add a Link"
   - Click "Link"

3. **Watch the graph grow**
   - Visit `/` to see raw MD-LD
   - Return to `/link/` to see the dashboard
   - Notice: iPhone → MacBook (directed link)
   - MacBook shows iPhone in "← Linked From"

4. **Create mutual links**
   - Generate token on MacBook
   - Paste on iPhone
   - Now both directions exist: iPhone ↔ MacBook

5. **Unlink**
   - Click "Unlink" on any outbound connection
   - The `link:linkedTo` quad is removed from the graph

## Patterns You Can Reuse

### Graph Codec Pattern
```javascript
import { parse, generate, DataFactory, expandIRI } from '../public/mdld-parse.js';

async function loadGraph() {
  const text = await readFile(DATA_FILE, 'utf8');
  return parse({ text, context: CONTEXT });
}

async function saveGraph(quads, context) {
  const { text } = generate({ quads, context });
  await writeFile(DATA_FILE, text);
}
```

### Append-Only Directed Edges
```javascript
function linkDevice(quads, childId, parentId) {
  const childNode = namedNode(expandIRI(`link:device/${childId}`, CONTEXT));
  const parentNode = namedNode(expandIRI(`link:device/${parentId}`, CONTEXT));
  const linkedToPred = namedNode(expandIRI('link:linkedTo', CONTEXT));

  const exists = quads.some(q =>
    q.subject.equals(childNode) && q.predicate.equals(linkedToPred) && q.object.equals(parentNode)
  );
  if (!exists) quads.push(quad(childNode, linkedToPred, parentNode));
  return quads;
}
```

### Stateless Token Signing
```javascript
function createToken(deviceId) {
  const exp = Date.now() + 3600000; // 1 hour
  const sig = crypto.createHmac('sha256', SECRET)
    .update(`${deviceId}.${exp}`)
    .digest('hex').slice(0, 16);
  return `${deviceId}.${exp}.${sig}`;
}
```

## Adapting This Component

### Change the Domain
Replace `tag:school.example.org,2026:link/` with your own tag URI:
```javascript
const PREFIX = 'tag:your-email@example.org,2026:your-app/';
```

### Add Properties
Extend the device schema with custom predicates:
```javascript
// Add to addDevice()
quad(deviceNode, namedNode(expandIRI('link:role', CONTEXT)), literal('admin')),
quad(deviceNode, namedNode(expandIRI('link:lastSeen', CONTEXT)), literal(new Date().toISOString()))
```

### Enforce Limits
Add business logic to `linkDevice()`:
```javascript
const outboundCount = quads.filter(q =>
  q.subject.equals(childNode) && q.predicate.equals(linkedToPred)
).length;

if (outboundCount >= 3) {
  throw new Error('Maximum 3 outbound links allowed');
}
```

### Add Mutual Link Detection
Find bidirectional edges:
```javascript
function hasMutualLink(quads, deviceIdA, deviceIdB) {
  const nodeA = namedNode(expandIRI(`link:device/${deviceIdA}`, CONTEXT));
  const nodeB = namedNode(expandIRI(`link:device/${deviceIdB}`, CONTEXT));
  const linkedToPred = namedNode(expandIRI('link:linkedTo', CONTEXT));

  const aToB = quads.some(q => q.subject.equals(nodeA) && q.predicate.equals(linkedToPred) && q.object.equals(nodeB));
  const bToA = quads.some(q => q.subject.equals(nodeB) && q.predicate.equals(linkedToPred) && q.object.equals(nodeA));

  return aToB && bToA;
}
```

## What This Doesn't Do

- **No persistence guarantee**: Soil is ephemeral. Container restart = state lost.
- **No authentication**: Anyone with the URL can link devices. Add auth if needed.
- **No visualization**: The graph is rendered as raw MD-LD. Add D3 or Cytoscape for visual graphs.
- **No access control**: All devices can see all links. Add visibility rules if needed.

## Philosophy

This component embodies the Forest Identity Protocol's core principle: **the Core provides cryptographic identity, components provide semantic meaning**.

The Core's only job is to verify the device cookie and inject `x-forest-device-id`. It knows nothing about links, networks, or users. This component takes that raw device ID and weaves it into a semantic graph of relationships.

No central user table. No shared state. No coordination. Just signed tokens, verified at the edge, and local graphs that components own entirely.

This is the forest at its purest: decentralized identity, sovereign components, and emergent networks. 🌲
