# AiroDrop — Master Implementation Plan (Production Polish)

> Created: July 22, 2026
> Status: In Progress
> Current Phase: Phase 8 — UI/UX Improvements

---

## Current State Assessment

The app is functional with a solid feature set (clipboard sync, file transfer, remote trackpad, screencast, relay P2P sharing, PIN auth). However, it has several gaps for production quality:

- No structured logging (raw `console.log` everywhere)
- No input validation/sanitization library
- No graceful shutdown handling
- Rate limiter is naive (in-memory, no sliding window)
- No request timeout handling
- Error responses inconsistent across routes
- No health monitoring beyond basic `/api/info`
- No `.env` support for config
- Frontend JS is inline/monolithic (~600+ lines each)
- No CSP headers or security hardening
- Missing comprehensive error boundaries
- No automated tests

---

## Phase 1: Security Hardening [COMPLETED]

| # | Task | Status |
|---|------|--------|
| 1.1 | Add Helmet.js for HTTP security headers | Done |
| 1.2 | Sanitize user inputs (filenames, text, paths) | Done |
| 1.3 | Add request size limits per route | Done |
| 1.4 | Harden CORS configuration | Done |
| 1.5 | Add PIN brute-force protection | Done |
| 1.6 | Secure cookie attributes | Done |
| 1.7 | Add CSRF protection for state-changing endpoints | Done |

---

## Phase 2: Error Handling & Logging [COMPLETED]

| # | Task | Status |
|---|------|--------|
| 2.1 | Implement structured logger (winston + daily rotate) | Done |
| 2.2 | Create centralized error handler middleware | Done |
| 2.3 | Wrap all route handlers with async error catching | Done |
| 2.4 | Add request ID tracking | Done |
| 2.5 | Add uncaught exception / unhandled rejection handlers | Done |

---

## Phase 3: Server Robustness [COMPLETED]

| # | Task | Status |
|---|------|--------|
| 3.1 | Add graceful shutdown handler | Done |
| 3.2 | Implement proper server health check endpoint | Done |
| 3.3 | Add request timeout middleware | Done |
| 3.4 | Improve rate limiter (sliding window, per-endpoint) | Done |
| 3.5 | Handle port conflicts gracefully | Done |
| 3.6 | Add file upload progress tracking | Skipped (already in chunked upload) |

---

## Phase 4: Code Quality & Architecture [COMPLETED]

| # | Task | Status |
|---|------|--------|
| 4.1 | Extract constants to dedicated constants file | Done |
| 4.2 | Create config validation module | Done |
| 4.3 | Add `.env` support with dotenv | Done |
| 4.4 | Add JSDoc annotations to key exported functions | Done |
| 4.5 | Refactor `src/utils.js` into focused modules | Deferred (low ROI vs risk) |
| 4.6 | Create `asyncHandler` wrapper utility | Done (Phase 2) |

---

## Phase 5: Frontend Polish [COMPLETED]

| # | Task | Status |
|---|------|--------|
| 5.1 | Add global fetch error handler with retry logic | Done |
| 5.2 | Add loading states for all async operations | Done |
| 5.3 | Improve offline handling and reconnection | Done |
| 5.4 | Add keyboard accessibility (focus, aria, navigation) | Done |
| 5.5 | Add service worker cache versioning | Done |

---

## Phase 6: Build & CI/CD

| # | Task | Status |
|---|------|--------|
| 6.1 | Add ESLint configuration | Pending |
| 6.2 | Add Prettier configuration | Pending |
| 6.3 | Add pre-commit hooks (husky + lint-staged) | Pending |
| 6.4 | Enhance GitHub Actions workflow | Pending |
| 6.5 | Add CHANGELOG.md generation | Pending |

---

## Phase 7: Relay Server Production Hardening

| # | Task | Status |
|---|------|--------|
| 7.1 | Add connection limits per IP | Pending |
| 7.2 | Add bandwidth throttling | Pending |
| 7.3 | Add structured logging | Pending |
| 7.4 | Add graceful shutdown | Pending |
| 7.5 | Add Prometheus-compatible metrics endpoint | Pending |

---

## Phase 8: UI/UX Improvements

> Priority: High — directly impacts user comprehension and adoption
> Status: Planned

### Bugs to Fix

| # | Bug | Severity | Status |
|---|-----|----------|--------|
| 8.1 | Mobile bottom nav CSS `display: none`/`flex` conflict causes load flicker | Low | Pending |
| 8.2 | Mobile `#mainAppContainer` shows blank page if JS fails to load (no fallback) | Medium | Pending |
| 8.3 | Inline `style=` attributes use hardcoded colors — themes partially broken | Medium | Pending |
| 8.4 | Cyberpunk theme forces `border-radius: 2px` globally — breaks mobile touch targets | Low | Pending |
| 8.5 | File browser iframe shows black box with no loading/error feedback | Medium | Pending |

### UX Improvements — Information Architecture

| # | Task | Impact | Status |
|---|------|--------|--------|
| 8.6 | Rename "Link Share (Send/Receive)" tab to "Share with Friend" | High | Pending |
| 8.7 | Move system controls (power/sleep/lock/media) from mobile header to Tools tab | High | Pending |
| 8.8 | Rename "Connect PC Services" button to "Connect Remote Control" — show only in Tools tab | Medium | Pending |
| 8.9 | Add blank-state fallback HTML for when JS fails to load (mobile) | Medium | Pending |
| 8.10 | Add loading spinner inside file browser iframe while `/files` loads | Low | Pending |

### UX Improvements — Labeling & Clarity

| # | Task | Impact | Status |
|---|------|--------|--------|
| 8.11 | Consolidate PC dashboard header buttons (Setup/Logs/Settings) into a single menu dropdown | High | Pending |
| 8.12 | Add "Quick Start" banner on first launch in iPhone Setup modal | Medium | Pending |
| 8.13 | Add text label to feed item delete buttons (or swipe-to-delete on mobile) | Medium | Pending |
| 8.14 | Add descriptive subtitles to each mobile tab section ("From PC → iPhone", "Send to PC") | Low | Pending |
| 8.15 | Add tooltip/help text to service status dropdown explaining what Start/Stop/Restart do | Low | Pending |

### UX Improvements — Visual Polish

| # | Task | Impact | Status |
|---|------|--------|--------|
| 8.16 | Extract inline styles from HTML into proper CSS classes for theme consistency | High | Pending |
| 8.17 | Add consistent transition animations when switching between mobile tabs | Low | Pending |
| 8.18 | Improve empty states with illustrations and actionable CTAs | Medium | Pending |
| 8.19 | Add visual feedback (button press states, loading spinners) for all async actions on mobile | Medium | Pending |
| 8.20 | Ensure all interactive elements meet 44px minimum touch target size on mobile | Medium | Pending |

### Implementation Priority (within Phase 8)

1. **High impact / Low risk:** 8.6, 8.7, 8.8, 8.9 (renaming + restructuring that doesn't break JS bindings)
2. **High impact / Medium risk:** 8.11, 8.16 (header consolidation, inline style extraction)
3. **Medium impact / Low risk:** 8.10, 8.12, 8.13, 8.14, 8.15, 8.18, 8.19, 8.20
4. **Low priority:** 8.1, 8.4, 8.5, 8.17 (minor visual issues)

---

## Dependencies to Add

### Phase 1
```
helmet              — HTTP security headers
hpp                 — HTTP parameter pollution protection
```

### Phase 2
```
winston             — Structured logging
winston-daily-rotate-file — Log file rotation
```

### Phase 4
```
dotenv              — Environment config
```

---

## Priority & Execution Order

1. **Phase 1** (Security) — Most critical for production [COMPLETED]
2. **Phase 2** (Error Handling) — Reliability and debuggability [COMPLETED]
3. **Phase 3** (Robustness) — Stability under load [COMPLETED]
4. **Phase 4** (Code Quality) — Maintainability [COMPLETED]
5. **Phase 5** (Frontend Polish) — Loading states, retry, accessibility [COMPLETED]
6. **Phase 8** (UI/UX) — Discoverability, clarity, and visual consistency
7. **Phase 6** (CI/CD) — Developer workflow
8. **Phase 7** (Relay Server) — Production deployment readiness
