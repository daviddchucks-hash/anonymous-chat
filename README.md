# Passerby: anonymous real-time stranger chat

Two people are matched at random, chat in real time, and the conversation disappears when it ends.
No accounts, no profiles, no database, no message history.

**Stack:** Node.js, Express, Socket.IO, and plain HTML/CSS/JavaScript (no frontend framework, no build step).

```
Open app → Choose interest → Find Stranger → Chat → End Chat → Conversation disappears
```

## What it does

- **Anonymous by design.** No email, phone, password, name or picture. Each conversation gives you a random server-generated name such as `Stranger-48291`, visible only during that conversation.
- **Matching.** A server-side queue pairs users who chose the same interest. If nobody shares it after a few seconds, the user is asked whether to match with anyone. Users never match themselves, cancelled/disconnected users leave the queue at once, and the queue logic is synchronous so a user can never be in two matches.
- **Real time.** Messages, typing indicators, online/offline status, end-chat, and reconnect handling.
- **Ephemeral.** Messages live only in server memory while the chat is active. When a conversation ends (or both users drop) the room and its messages are wiped. Message text is never logged.
- **Safety.** Report, block, message rate limit, length limit, duplicate-spam detection, word filter, link blocking, strike system with automatic temporary bans.
- **Security.** Helmet + strict Content-Security-Policy, CORS allow-list, WebSocket origin check, per-IP connection limit, payload size limit, server-side validation of every event, XSS-safe rendering.

## Honest privacy statement

Anonymity from *other users* is **not** the same as network anonymity. The server and its hosting/network infrastructure can still process connection metadata such as IP addresses, and the other person can copy or screenshot what you write. The app never shows IPs, socket IDs, session tokens or room names to the other user, and it never stores raw IP addresses (they are HMAC-hashed into short opaque tokens for rate limiting, bans and report counting). It does **not** claim to be untraceable.

## Project structure

```
anonymous-chat/
├── server.js               Express + Socket.IO bootstrap, security headers, CORS, shutdown
├── package.json
├── .env.example            All configuration, documented
├── render.yaml             Render blueprint
├── public/
│   ├── index.html          Landing + interest selection
│   ├── chat.html           Matching, chat, ended and error states
│   ├── css/style.css
│   └── js/app.js, chat.js
├── src/
│   ├── config.js           Env parsing with clamped limits
│   ├── matching.js         Waiting queue
│   ├── rooms.js            Temporary rooms + aliases
│   ├── users.js            Ephemeral in-memory sessions
│   ├── socketHandlers.js   All socket events and lifecycle rules
│   ├── moderation.js       Sanitising, word filter, strikes, bans, reports
│   └── rateLimiter.js      Sliding-window + connection limiters
├── routes/
│   ├── health.js           GET /healthz
│   └── admin.js            Optional read-only moderation API
└── test/                   Unit, flow, integration and UI tests
```

## Run locally

Requires Node.js 18.17 or newer.

```bash
cd anonymous-chat
npm install
cp .env.example .env      # optional: defaults work
npm run dev               # or: npm start
```

Open <http://localhost:3000> in **two browser windows** (or one normal and one private window; sessions are per tab) and pick the same interest in both. Two tabs from one machine share an IP, which is allowed by default so you can test.

## Configuration

Everything is an environment variable; see `.env.example`. The important ones:

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Set `production` when deployed |
| `PORT` | `3000` | Provided by the host on most platforms |
| `CORS_ORIGINS` | *(empty)* | Extra allowed origins. Empty = same-origin only |
| `TRUST_PROXY` | `1` in production | Reverse proxies in front of the app (used to read the client IP) |
| `IP_HASH_SECRET` | random per start | Secret for hashing IPs. Set it so bans survive restarts |
| `ADMIN_TOKEN` | *(off)* | 24+ chars enables `/admin/api` |
| `MAX_MESSAGE_LENGTH` | `500` | Characters per message |
| `MESSAGE_RATE_MAX` / `_WINDOW_MS` | `5` / `5000` | Messages allowed per window |
| `RECONNECT_GRACE_MS` | `20000` | How long a refresh or network drop may take before the chat ends |
| `INTEREST_MATCH_TIMEOUT_MS` | `15000` | Wait time before offering "match with anyone" |
| `BLOCK_SAME_IP_MATCH` | `false` | Stop users on one network matching each other |
| `ALLOW_LINKS` | `false` | Links in messages are refused by default |
| `BLOCKED_WORDS` | *(empty)* | Extra words to mask, comma-separated |
| `STRIKE_LIMIT`, `BAN_DURATION_MS` | `8`, `600000` | Abuse score before an automatic 10-minute ban |
| `REPORT_AUTO_BAN_THRESHOLD` | `3` | Distinct reporters needed for an automatic ban |
| `REPORT_INCLUDE_MESSAGES` | `false` | Attach the reported user's last 5 messages to a report |

## Socket events

Client → server (each takes an acknowledgement callback returning `{ ok, error? }`):

| Event | Payload | Notes |
|---|---|---|
| `find_stranger` | `{ interest, anyone? }` | `anyone: true` opts in to any topic |
| `cancel_matching` | none | Leaves the queue |
| `send_message` | `{ text }` | Validated, filtered, rate limited |
| `typing_start` / `typing_stop` | none | Relayed to the partner only |
| `end_chat` | none | Ends and destroys the room |
| `report_user` | `{ reason, note? }` | `spam, harassment, sexual_content, hate_speech, underage, other` |
| `block_user` | none | Ends chat; the pair is never matched again this session |

Server → client: `session`, `match_found`, `no_interest_match`, `receive_message`, `typing_start`, `typing_stop`, `partner_status`, `chat_ended` (`you_ended`, `partner_ended`, `partner_disconnected`), `connection_error` (`banned`, `too_many_connections`, `session_replaced`, `rate_limited`, `server_restarting`, `server_error`).

## How refresh and reconnect work

Each tab receives a random secret session token, kept in `sessionStorage` (per tab, cleared when the tab closes). If the connection drops, the server keeps the chat alive for `RECONNECT_GRACE_MS`. The partner sees "Stranger is reconnecting…". If the user returns in time (refresh, network change), the chat resumes with its history; if not, the chat ends for the partner with "The stranger has left the conversation." Queued users are removed from the queue immediately on disconnect and search again after reconnecting.

## Moderation structure

`src/moderation.js` holds an in-memory `ModerationStore` with `addReport`, `list`, `resolve`, `ban`, `isBanned` and `stats`. A report contains only: id, time, reason code, optional 200-character note, an opaque network token of the reported person, their temporary alias, and two counters (conversation age, message count). It does not include the reporter's identity or, by default, message text.

Set `ADMIN_TOKEN` to expose a small read-only API for a future dashboard:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://your-app/admin/api/stats
curl -H "Authorization: Bearer $ADMIN_TOKEN" "https://your-app/admin/api/reports?status=open"
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
     -d '{"status":"resolved"}' https://your-app/admin/api/reports/r1/resolve
```

To persist reports later, replace `ModerationStore` with a database-backed class exposing the same methods.

## Tests

```bash
npm test                    # 72 unit + flow tests, no network or extra packages needed
npm run test:integration    # real Express + Socket.IO + socket.io-client (needs npm install)
```

- `test/flow.test.js` runs the **real** handler code through an in-memory Socket.IO stand-in and covers matching, interests, simultaneous users (200 at once), message delivery and isolation, typing, ending, disconnect/reconnect, queue cancellation, rate limiting, report/block, XSS strings, abuse bans, connection limits and proxy-IP handling.
- `test/integration.test.js` repeats the key scenarios over real HTTP and WebSockets and checks security headers, admin API auth and cross-origin refusal.
- `test/ui-sim.js` (optional; needs `npm i -D playwright && npx playwright install chromium`) drives the real frontend in headless Chromium against the real handler logic under the production Content-Security-Policy and writes screenshots to `test/screenshots/`.

## Deploy on Render

1. Push this folder to a GitHub repository. (Run `npm install` once locally and commit `package-lock.json`.)
2. In Render choose **New → Blueprint** and select the repo (it reads `render.yaml`), or **New → Web Service** with:
   - Build command: `npm install --omit=dev` (or `npm ci --omit=dev` with a lockfile)
   - Start command: `npm start`
   - Health check path: `/healthz`
3. Environment variables: `NODE_ENV=production`, `TRUST_PROXY=1`, `IP_HASH_SECRET=<long random string>`, and optionally `ADMIN_TOKEN`. Leave `CORS_ORIGINS` empty because the frontend and backend are the same service.
4. Deploy. Render terminates HTTPS and supports WebSockets, so `https://<your-app>.onrender.com` works out of the box.

**Important limits:**
- Run **one instance only**. Chats, the queue and bans live in that process's memory. Scaling out needs a shared store (for example the Socket.IO Redis adapter), which this MVP intentionally does not include.
- The free plan sleeps when idle and every restart or deploy ends all active chats. Use a paid plan for real use.
- Rate limits and bans key on hashed client IPs. Users behind one shared IP (schools, offices, mobile carriers) share those limits.

## Known limitations

- The word filter is intentionally basic. Extend it with `BLOCKED_WORDS` and expect determined users to evade it.
- Reports are only possible during an active chat. Bans are per hashed IP and temporary.
- Block persists for the browser tab's session, not across tabs or devices, since there are no accounts.
- Messages are text only. Server-side content is sanitised (control, invisible and bidi-override characters removed) and rendered with `textContent`, so it is never interpreted as HTML.
- Age confirmation is a self-declaration checkbox, not verification.
