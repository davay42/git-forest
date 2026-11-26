# notify/ — Web Push Notifications Template

A minimal component demonstrating browser push notifications in a forest: an SSE counter everyone can watch, and Web Push delivery to subscribed devices when the count changes.

## What it does

- `GET /` — counter page with a live SSE stream (`/events`), a subscribe button, and a count increment button
- `POST /subscribe` — stores a browser `PushSubscription` in `subscriptions.json`
- `POST /increment` — bumps the counter, broadcasts over SSE, and sends a Web Push notification to every subscriber
- `report.md` — append-only log of notification sends (count, time, subscriber count)

## Configuration

Web Push requires VAPID keys. Generate a pair and export them before boot:

```bash
npx web-push generate-vapid-keys
```

```bash
export VAPID_PUBLIC_KEY=...
export VAPID_PRIVATE_KEY=...
export VAPID_SUBJECT=mailto:you@example.com   # optional
```

Without keys the component still boots and serves the counter — the boot log shows `VAPID=✗` and subscribe attempts fail with an alert. Push requires HTTPS (or localhost) in the browser.

## Soil

`subscriptions.json` and `report.md` are runtime state — a `.gitignore` ships with the template.
