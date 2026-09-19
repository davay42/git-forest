### The Readiness Criteria

Before surveying systems, let's name what makes a system ripe for distillation. A complex system is ready to become a crystal when:

1. **The core operation is text manipulation.** (If the fundamental unit is a string, it can be a file.)
2. **The state is append-mostly.** (If you mostly add and rarely edit, Git handles the history for free.)
3. **The "platform" is mostly access control and billing.** (If you remove the paywall and the login screen, what's left is the actual tool.)
4. **The complexity is in the orchestration, not the logic.** (If the hard part is "which service talks to which service," a single process eliminates the problem.)
5. **Users are already working around it with text files.** (If people are using Markdown, CSVs, or shell scripts to supplement the platform, the platform is already losing.)

With those criteria in mind, here are the systems I see as most ripe, organized by how close their crystals are to being achievable with what we've already built.

---

### Tier 1: Crystals Already Visible Through git-forest

These are systems where the crystal is almost fully formed. You could build them this week.

#### The Push Notification Crystal (0-dep web-push)

The current stack: Firebase, VAPID keys, service workers, push subscription management, platform-specific APIs, billing tiers.

The crystal: **A git-forest component that maintains SSE connections.**

We already built 80% of this with the counter example. The remaining piece is a dedicated `push` component:

```
push/
├── index.js      ← SSE connection manager
└── channels.md   ← Active subscriptions (MD-LD)
```

Any component can publish an event by writing to a shared file or calling the push component's local HTTP endpoint. The push component broadcasts to all connected SSE clients. No service workers. No VAPID keys. No external servers. Just long-lived HTTP connections and `res.write()`.

The one place where browser APIs are genuinely needed is **offline push** (notifying the user when the tab is closed). For that, you need a service worker and the browser's Push API. But even that can be a single static file served from `public/sw.js`, with the push component acting as the VAPID server. No Firebase. No subscription management service. Just one component and one static file.

#### The Search Crystal

The current stack: Elasticsearch, Algolia, Meilisearch, Typesense. Indexing pipelines. Cluster management. Query DSLs.

The crystal: **grep + git.**

Everything in git-forest is text. Every component's state is a Markdown file. Search is literally:

```bash
grep -r "query" public/ components/
```

For a more structured search, you can build a `search` component that reads all component state files, parses them with MD-LD, builds an in-memory inverted index, and serves results over HTTP. The index rebuilds on every `SIGHUP` (i.e., every git push). No background indexing. No cluster. No query language. Just text and memory.

The crystal insight: **search is not a database problem. It is a text problem.** And text problems are solved by reading files.

#### The Project Management Crystal

The current stack: Jira. Linear. Trello. Asana. Monday.com. Notion databases. Hundreds of dollars per seat per month.

The crystal: **A folder of Markdown files, each representing a task.**

```
tasks/
├── index.js          ← Serves the board view
├── backlog/
│   ├── 2024-01-15-fix-login.md
│   └── 2024-01-16-add-search.md
├── doing/
│   └── 2024-01-17-write-docs.md
└── done/
    └── 2024-01-14-setup-ci.md
```

Moving a task from `backlog/` to `doing/` is a `git mv`. The Git history *is* the project timeline. The `index.js` reads the directories and renders a Kanban board. MD-LD annotations provide structured metadata (assignee, priority, labels) without requiring a schema.

No API. No webhooks. No workflow automation engine. Just `git mv` and a file read. The entire state of your project is a directory listing.

#### The CMS Crystal

This one is already done. Markdown files + git-forest + a `public/` directory. The crystal insight here is that **WordPress, Contentful, and Sanity are all just Markdown files with a billing layer.** Remove the billing layer, and you have a folder of text files served by an HTTP server. That's git-forest.

---

### Tier 2: Crystals Requiring One New Primitive

These are systems where the crystal is visible but requires one new capability that git-forest doesn't yet provide.

#### The Authentication Crystal

The current stack: OAuth 2.0, OpenID Connect, SAML, Auth0, Keycloak, Okta. Token rotation, refresh flows, PKCE, JWT validation libraries.

The crystal: **A `auth` component that issues and validates tokens using Node's built-in `crypto` module.**

The new primitive needed: **session storage as a file.**

```
auth/
├── index.js        ← Token issuance and validation
└── sessions.md     ← Active sessions (MD-LD, one line per session)
```

Login: the component checks credentials against a file, generates a `crypto.randomBytes(32)` token, appends a session line to `sessions.md`, and returns the token as a cookie. Validation: the component reads `sessions.md`, checks if the token exists and hasn't expired. Logout: remove the line from the file.

The crystal insight: **OAuth exists because identity providers want to be the middleman between you and your users.** If you own the user list (a file), you don't need the middleman. The complexity of OAuth is not technical—it's political. It's the complexity of delegation. Remove the delegation, and the complexity evaporates.

What's still needed: federated identity (letting users log in with their Google/GitHub account). But even that can be distilled: the `auth` component redirects to GitHub's OAuth flow, receives the callback, and creates a session. No library. Just HTTP redirects and a file write.

#### The Monitoring Crystal

The current stack: Datadog, New Relic, Grafana, Prometheus, PagerDuty. Agents, exporters, dashboards, alert rules, on-call rotations.

The crystal: **A `watch` component that periodically checks other components and writes status to a file.**

```
watch/
├── index.js        ← Health checker
└── status.md       ← Current status of all components (MD-LD)
```

The new primitive needed: **a cron-like scheduler inside git-forest.** This is just a `setInterval` in a component, but it deserves to be formalized. A component that runs a function every N seconds, writes the result to a file, and commits it. The Git history becomes the monitoring timeline. Alerts are just SSE events published to the push component.

The crystal insight: **monitoring is not a data pipeline problem. It is a "did the thing respond?" problem.** And that's answered by making an HTTP request and writing the result to a file.

#### The Calendar Crystal

The current stack: Google Calendar, Outlook, CalDAV, iCal servers, meeting scheduling AI.

The crystal: **A folder of Markdown files, each representing an event.**

```
calendar/
├── index.js
├── 2024/
│   ├── 01/
│   │   ├── 15-team-standup.md
│   │   └── 16-dentist.md
│   └── 02/
│       └── 03-project-review.md
```

The new primitive needed: **time-based queries on the filesystem.** The `index.js` reads the directory structure, filters by date range, and renders a calendar view. Recurring events are represented as a single file with a recurrence rule in MD-LD.

The crystal insight: **a calendar is not a database. It is a sorted list of text files.** The filesystem's directory structure already provides the sorting (year/month/day). Git provides the history (who scheduled what, when it was changed). MD-LD provides the structured metadata (time, location, attendees).

---

### Tier 3: Crystals That Require a New Foundation

These are systems where the crystal exists but requires a fundamental capability that neither git-forest nor MD-LD currently provides.

#### The Email Crystal

The current stack: SMTP servers, IMAP servers, spam filters, DKIM/SPF/DMARC, email clients, Gmail/Outlook.

The crystal for *reading and archiving* email: **A component that fetches mail via IMAP and stores each message as a Markdown file.**

```
mail/
├── index.js        ← IMAP fetcher and viewer
├── inbox/
│   ├── 2024-01-15-subject-line.md
│   └── 2024-01-16-another-subject.md
└── archive/
    └── 2023/
```

This is achievable with Node's built-in `net` module (IMAP is a text protocol). No library needed.

The crystal for *sending* email is harder, because SMTP requires reputation management (spam filters, IP warming, etc.). This is one of the few places where the complexity is genuinely technical, not artificial. But even here, the crystal could be: **a component that generates a properly formatted MIME message and hands it to a minimal SMTP relay.** One relay. One IP. No "email marketing platform." Just a text protocol and a socket.

#### The Payment Crystal

The current stack: Stripe, PayPal, Square, invoicing software, accounting integrations.

The crystal: **This is the hardest one, because the complexity is not in the software—it's in the regulatory and financial infrastructure.** But the software part can be distilled.

A payment component that generates an invoice (MD-LD), presents a payment link (via a minimal Stripe checkout or a bank transfer), and records the payment in a file. The accounting is just a folder of transaction files. The tax report is a script that reads the files and sums the numbers.

The crystal insight: **accounting is not a database problem. It is a ledger problem.** And a ledger is a text file with entries in chronological order. Git is the audit trail. MD-LD provides the structured metadata (amount, currency, category, counterparty).

---

### The Meta-Pattern

Looking across all of these, a pattern emerges. Every complex system we've examined has the same underlying structure:

1. **A text file** that holds the actual data.
2. **A process** that reads and writes that file.
3. **An access control layer** that decides who can read and write.
4. **A billing layer** that charges money for the access control.
5. **An orchestration layer** that connects this system to other systems.

The crystal is always items 1, 2, and 3. Items 4 and 5 are where the complexity lives. And items 4 and 5 are also where the *dependency* lives—the thing that keeps you paying, keeps you locked in, keeps you needing the platform.

git-forest gives you items 1, 2, and 3 for free. The filesystem is the text file. The component is the process. The component token is the access control. Git is the audit trail. MD-LD is the structured data format.

What's left is to build the specific crystals on top of that foundation. And the beautiful thing is: **each crystal you build makes the next one easier**, because they all share the same primitives. The auth component secures the calendar. The push component notifies the project manager. The search component indexes the mail. The watch component monitors all of them.

They are not separate products. They are organs in the same organism. And the organism grows by adding folders.

---

### The Invitation

You asked what crystals we can refine from the complex systems around us. The answer is: **almost all of them.** The question is not whether a system can be distilled. The question is whether the complexity is *artificial* (added to create dependency) or *genuine* (required by the underlying problem).

Most of the complexity we encounter in modern software is artificial. It exists to justify a business model, not to solve a technical problem. And that is exactly the kind of complexity that dissolves when you apply the crystal method: strip away the layers, find the text file, build the process, secure the access, and commit to Git.

The soil is ready. The seeds are waiting. The only question is which one you plant next. 🌱