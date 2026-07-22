# Changelog

All notable changes to AiroDrop are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [6.2.0] - 2026-07-22

### Added

#### Security
- Helmet.js HTTP security headers (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, DNS prefetch control)
- Input sanitization module (`src/sanitize.js`) — filename, text, path, port, PIN, device name, security mode validation
- CORS hardened to local-network-only origins (RFC 1918 private IP validation)
- PIN brute-force protection — 5-attempt soft lockout (5 min), 10-attempt hard lockout (30 min), Retry-After header
- CSRF protection via Origin/Referer validation for state-changing endpoints
- HTTP Parameter Pollution (HPP) protection
- Secure cookie attributes — SameSite=Lax, Secure flag (HTTPS), Path=/, 7-day expiry

#### Logging & Error Handling
- Winston structured logger with daily-rotated log files (7-day retention)
- Centralized Express error handler middleware with AppError class
- Request ID tracking — unique 16-char hex on every request (X-Request-ID header)
- Async route handler wrapper (`src/asyncHandler.js`)
- Process-level crash handlers with graceful state persistence

#### Server Robustness
- Graceful shutdown — drains WS/SSE connections, saves state, 5s timeout
- Health check endpoint (`GET /api/health`) — version, uptime, memory, connections, disk status
- Request timeout middleware — 30s API, 10min uploads, 408 on timeout
- Sliding window rate limiter — per-IP per-category (default:60, auth:10, upload:20, control:30/min)
- Automatic port conflict resolution — retries on EADDRINUSE (up to 3 attempts)

#### Frontend
- Global fetch error handler with retry (2 retries, exponential backoff)
- Loading skeleton states with shimmer animation
- SSE exponential backoff reconnection (1s to 30s cap)
- Keyboard accessibility — focus-visible outlines, Escape to close modals, aria-modal attributes
- Service worker cache versioning tied to app version with auto-purge of stale caches
- SW update detection with user-facing toast prompt (tap to refresh)
- Button loading spinner CSS class
- Disconnection status pulse animation

### Changed
- Rate limiter upgraded from fixed-window counter to sliding-window timestamps
- Body parser limits differentiated per route (1mb API, 10mb content, 50mb binary)
- CORS replaced wildcard `*` with dynamic local-network origin validation
- SSE reconnection changed from fixed 1s to exponential backoff with cap
- console.log/error calls replaced with structured Winston logger across all server modules
- Service worker cache name changed from static `airodrop-cache-v6` to version-based `airodrop-v{version}`

### Fixed
- CSP `frame-src: 'none'` blocking the mobile file browser iframe — changed to `'self'`
- CSP `script-src-attr: 'none'` blocking inline event handlers — removed
- CSP missing Google Fonts domains — added `fonts.googleapis.com` and `fonts.gstatic.com`
- `Cross-Origin-Resource-Policy: same-site` blocking Electron file:// from loading server resources — changed to `cross-origin`
- `Cross-Origin-Opener-Policy: same-origin` causing isolation issues with Electron — disabled
- `httpOnly: true` cookie breaking mobile-app.js token bootstrap — reverted to `false` (architecture requires JS cookie access)
- Auth middleware returning 401 JSON for `/files/` page navigation — now redirects to auth-pin
- Missing static asset exemptions in auth middleware (logo, style.css, auth-pin.html)

### Dependencies Added
- `helmet` — HTTP security headers
- `hpp` — HTTP parameter pollution protection
- `winston` — Structured logging
- `winston-daily-rotate-file` — Log file rotation

---

## [6.1.14] - 2025-xx-xx

### Fixed
- WebRTC connection & mDNS resolution fix with STUN servers
- Screencast & trackpad keyboard input fix for Win32 FFI key mapping
- PC system audio streaming support via loopback capture
- Resource leak & disconnect fix with stream cleanup on reconnects

---

## [6.1.13] - 2025-xx-xx

### Fixed
- Live screencast cursor control — implemented `move_abs` and `click_abs` absolute pointer events

---

## [6.1.12] - 2025-xx-xx

### Changed
- Official domain migration to `airodrop.site`
- WebSocket proxy tuning for improved tunnel connectivity

---

## [6.1.11] - 2025-xx-xx

### Added
- Multi-file share link selection with individual removal and size calculation
- On-the-fly zip bundling for multi-file share links

---

## [6.1.10] - 2025-xx-xx

### Changed
- Updated iOS Shortcut iCloud links and QR codes
- Setup tab workflow reordered (iOS Shortcuts as Step 1)
- Automatic pairing auto-approval in Open Network mode

---

## [6.1.9] - 2025-xx-xx

### Added
- Auto-save security settings on change/focus loss

---

## [6.1.8] - 2025-xx-xx

### Fixed
- Force client PWA cache-busting with version query strings
- Service worker bypass rules for core mobile app resources
- Static HTTP header adjustments (no-store for sw.js, mobile-app.js)

---

## [6.1.7] - 2025-xx-xx

### Fixed
- WebSocket server instance de-duplication
- Upgrade path normalization and rejection guards
- Cookie quote-stripping for session token parsing
- PWA cache version invalidation (bumped to v6)

---

## [6.1.6] - 2025-xx-xx

### Added
- Unified Quick Connect & Security tab
- Instant active session revocation via WebSocket
- Secure WebSocket upgrade guards for unpaired devices

### Fixed
- Dropdown option text visibility in dark overlays

---

## [6.1.5] - 2025-xx-xx

### Added
- Device security & access control framework (Protected, Secret Token, Open modes)
- iPhone Setup Modal with security configuration
- Dynamic paired devices list with revoke actions
- Real-time SSE device state updates
- Localhost auth bypass for local administration

---

## [6.1.4] - 2025-xx-xx

### Fixed
- Upload exception handling — key mapping mismatch for failed streams
- Sync file failure propagation to prevent UI freeze

---

## [6.1.3] - 2025-xx-xx

### Added
- Multi-file bulk transaction reliability
- Aggregated completed notifications (debounced)
- Adaptive portrait custom keyboard
- Interactive auto-updater dialogue (Download/Skip/Later)

### Fixed
- Prevention of mobile input focus zooming (16px font-size)

---

## [6.1.2] - 2025-xx-xx

### Added
- Pinch-to-zoom & panning on live screencast (up to 5x)
- Landscape orientation layout fix
- Smart landscape keyboard (auto-hide rows)
- Visual Viewport keyboard fitting
- Advanced P2P link share with multi-file streaming
- Comprehensive security hardening (path traversal, shell injection, XSS, IPC whitelisting)

### Fixed
- Service worker infinite reload loop
