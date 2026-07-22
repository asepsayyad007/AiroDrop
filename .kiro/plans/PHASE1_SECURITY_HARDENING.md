# Phase 1: Security Hardening — Implementation Plan

> Parent: MASTER_IMPLEMENTATION_PLAN.md
> Status: In Progress
> Started: July 22, 2026

---

## Overview

Harden the AiroDrop Express server against common web security vulnerabilities. Since this app runs on a local network (and optionally exposes a relay to the internet), security must balance usability with protection.

---

## Task 1.1: Add Helmet.js for HTTP Security Headers

**File:** `src/middleware.js`

- Install `helmet` package
- Apply helmet with sensible defaults for a local-network Electron app
- Configure CSP to allow inline scripts (needed for current frontend architecture)
- Disable `crossOriginEmbedderPolicy` (breaks local resource loading)
- Add `X-Content-Type-Options: nosniff`
- Add `X-Frame-Options: SAMEORIGIN`
- Add `Referrer-Policy: strict-origin-when-cross-origin`

---

## Task 1.2: Sanitize User Inputs

**Files:** `src/routes/clipboard.js`, `src/routes/settings.js`, `src/routes/files.js`

- Create `src/sanitize.js` utility module
- Sanitize filenames: strip path separators, null bytes, control chars, enforce max length
- Validate text input: max length enforcement, strip null bytes
- Validate path parameters: prevent directory traversal beyond safe boundaries
- Validate port numbers, device names, and settings values with type checking

---

## Task 1.3: Add Request Size Limits Per Route

**File:** `src/middleware.js`

- Currently: global 10mb JSON, 50mb raw — too permissive for non-upload routes
- Set stricter limits: 1mb for JSON API bodies, 10mb for text endpoints
- Keep 10GB limit only on file upload routes (already scoped via multer)
- Add `express-validator` or manual checks for payload size on sensitive endpoints

---

## Task 1.4: Harden CORS Configuration

**File:** `src/middleware.js`

- Replace wildcard `*` CORS with dynamic origin checking
- Allow: localhost origins, local network IPs (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
- Allow: the server's own IP and configured device IPs
- Reject: external origins unless in relay/share mode
- Add `Access-Control-Allow-Credentials: true` for cookie-based auth
- Restrict `Access-Control-Allow-Headers` to actually used headers

---

## Task 1.5: Add PIN Brute-Force Protection

**Files:** `src/auth.js`, `src/routes/auth.js`

- Track failed PIN attempts per IP in memory (Map with timestamps)
- After 5 failed attempts: lockout for 5 minutes
- After 10 failed attempts: lockout for 30 minutes
- Return `429 Too Many Requests` with `Retry-After` header during lockout
- Auto-clear expired lockout entries every 10 minutes
- Log brute-force attempts with IP and timestamp

---

## Task 1.6: Secure Cookie Attributes

**Files:** `src/routes/auth.js`, `src/auth.js`

- Set `HttpOnly: true` on `airodrop_session` cookie (prevent XSS theft)
- Set `SameSite: Lax` (allow same-site navigations but block cross-site POST)
- Set `Secure: true` when HTTPS is enabled
- Set `Path: /` for cookie scope
- Add `Max-Age` based on reasonable session duration (7 days)

---

## Task 1.7: Add CSRF Protection for State-Changing Endpoints

**Files:** `src/middleware.js`, `src/routes/settings.js`

- For browser-based requests: validate `Origin` or `Referer` header matches server
- For API requests: require `X-Requested-With: XMLHttpRequest` or auth token
- Exempt iOS Shortcut endpoints (they use `X-AiroDrop-Token` header)
- Exempt localhost/loopback requests (Electron app)
- Light-touch approach since this is primarily a local-network tool

---

## Dependencies

```bash
npm install helmet hpp
```

---

## Files Modified

- `src/middleware.js` — Tasks 1.1, 1.3, 1.4, 1.7
- `src/auth.js` — Tasks 1.5, 1.6
- `src/routes/auth.js` — Tasks 1.5, 1.6
- `src/routes/clipboard.js` — Task 1.2
- `src/routes/settings.js` — Task 1.2
- `src/routes/files.js` — Task 1.2
- `src/sanitize.js` — Task 1.2 (new file)
- `package.json` — Dependencies

---

## Verification

- Server starts without errors after changes
- Existing functionality (text/file transfer, auth, settings) still works
- Security headers present in responses (check with browser DevTools)
- PIN lockout triggers correctly after threshold
- CORS rejects external origins
- File uploads still work with proper limits
