# Bharat Pulse — Local Map Social

A hyperlocal, map-first social network. Posts are pinned to real coordinates
on an interactive map instead of living in a scrolling feed. Runs on one
machine and is reachable from any phone/laptop on the same WiFi — no cloud
hosting required.

## 1. Install

Requires Node.js v18+.

```
cd india-social
npm install
```

## 2. Run

```
npm start
```

You'll see:

```
=== Bharat Pulse server running ===
Local:   http://localhost:3000
Network: http://192.168.1.42:3000  <-- open this on your phone (same WiFi)
====================================
```

## 3. Access from your phone

1. Phone must be on the **same WiFi** as the computer running the server.
2. Open the `Network:` address shown in the terminal on your phone's browser.
3. Sign up, allow location access, and you're live on the map.

If it won't connect: check your firewall isn't blocking port 3000, confirm
both devices are on the same WiFi (not "Guest" vs main), and on Windows allow
Node.js through Defender Firewall the first time you run it.

## 4. Going beyond the same WiFi (optional)

Deploy `server.js` to a real host (Render, Railway, a VPS) and swap the
`db.json` file storage for a real database before real users touch it —
file storage here is intentionally simple for local/demo use.

## GPS accuracy — the honest version

Phone GPS via a browser typically lands within 3–20m, not 1m — that's a
hardware limit; 1m needs RTK-grade GNSS chips phones don't have. This app
does the two things that actually help: keeps sampling location and only
updates your pin when a *more accurate* reading comes in, and lets you
**drag your marker** to correct it manually before posting.

## Full feature list

**Core**
- Real accounts: hashed passwords, JWT sessions, profile picture + bio
- Map-first interface (Leaflet + free OpenStreetMap tiles + India boundary)
- Text-required posts with optional **image or video** attached
- Auto-expiring posts (1h/6h/24h/7d), manual delete, 5-minute edit window
- Upvotes + a separate ❤️ love reaction, view counts, pin-to-profile
- Threaded comments with likes and nested replies — all live via WebSockets

**Discovery**
- Search-first labels: no fixed category list — type to find or create one,
  multiple labels per post
- Working `#hashtags`, auto-extracted, clickable, searchable, with a live
  trending strip
- Unified worldwide search bar (press `/` to focus it): real places via
  OpenStreetMap geocoding (not India-locked), post text, labels, hashtags
- `@mentions` that notify people and link to their profile
- Feed sort toggle: Newest / Top

**Real messaging**
- Persisted 1:1 conversations, real-time delivery, unread counts, typing
  indicator, presence (online / last seen), and message unsend

**Social graph**
- Follow/followers, public profile pages, in-app notifications (follows,
  upvotes, comments, mentions), bookmarking, one-click shareable post links,
  mute (silent, one-way) separate from block (mutual)

**Appearance — fully customizable**
- User-adjustable **accent color** (color picker, live, persisted)
- Light/Dark theme mode
- Optional **Pixel Mode** (retro monospace + hard shadows), toggle-only —
  never forced on you
- Professional default look: soft elevation shadows, avatar rings, hover lift

**Personal data controls**
- Export your data as JSON, permanently delete your account (cascades to
  your posts, comments, conversations, and notifications)

**Security**
- bcrypt password hashing, JWT sessions (7-day expiry)
- Rate limiting on auth + general API (brute-force defense)
- Account lockout after 5 failed logins (15-minute cooldown)
- Helmet security headers, image/video-only upload filter, 25MB limit
- Block (mutual) and mute (one-way, silent) users
- Report-and-auto-hide (3 reports auto-hides a post)
- All user text is HTML-escaped before rendering (XSS protection)

**Things that don't really exist elsewhere yet**
1. **Decay visualization** — posts visually fade on the map and feed as they
   near expiry — a glanceable sense of "freshness" with no timestamp reading.
2. **Anonymous Safety Flare** — one-tap emergency broadcast: a glowing red
   pin, no profile attached, auto-expires in an hour.
3. **Local Pulse counter** — live count of what's happening in your radius.
4. **Best-of-N GPS lock + drag-to-correct** — keeps listening for a better
   fix instead of trusting the first one, shows the real error radius.
5. **Search-first, zero-preset labeling** — search or create labels on the
   fly instead of picking from a fixed dropdown; multiple stack per post.

## Ideas for later (not built, for you to prioritize)
- **Border Bridge**: posts near a border also surface briefly just across it
- Proximity chat rooms that auto-form when several users cluster nearby
- Regional-language auto-tagging with inline translation toggle
- Two-factor authentication (TOTP) for login
- Push notifications (needs a service worker + VAPID keys)
- Polls, scheduled posts, GIF picker, voice-note posts, 24h stories
- Verified badges, group chats, moderator dashboard, PWA installability

## Free map / location data (if you want offline data instead of live geocoding)
- **Nominatim** (already wired in, live, free, worldwide, no key needed)
- **Natural Earth** — naturalearthdata.com/downloads — free vector boundaries
- **GeoNames** — download.geonames.org/export/dump — every named place on Earth
- **OpenStreetMap Planet** — planet.openstreetmap.org — full OSM database
