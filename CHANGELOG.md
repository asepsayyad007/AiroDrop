# Changelog

All notable changes to AiroDrop are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.4.70] - 2026-08-15

### Added
- **Visual 6-Step Safari iOS PWA Installation Guide** — Integrated 6 high-resolution step-by-step screenshots (`pwa_step1.jpg` to `pwa_step6.jpg`) into `Setup Guide ➔ iPhone ➔ Safari WebApp (PWA)` walking users through opening Safari, tapping three dots, selecting share, expanding menu, adding to home screen, and launching AiroDrop directly from their iPhone Home Screen.
- **Visual 2-Step iPhone Shortcuts Setup Guide** — Added an interactive 2-step setup guide with embedded screenshots (`shortcut_step1.png` and `shortcut_step2.png`) detailing how to edit imported Apple Shortcuts and update the dynamic IP & Port address field (`http://<PC-IP>:3479`).
- **1-Tap Phone Install Warning Alert Banner** — Prominent warm amber warning callout (`#facc15`) positioned above the `Official iOS Shortcuts QR` header instructing users on 1-tap phone installation (`Settings ➔ iPhone Setup`).
- **Faded Red Glassmorphism Setup Button (`#btnDashSetupGuide`)** — Renamed dashboard header button to **Mobile App Setup** with a subtle faded red glassmorphism aesthetic (`background: rgba(239, 68, 68, 0.12)`, `border: 1px solid rgba(248, 113, 113, 0.35)`, `color: #fca5a5`, `box-shadow: 0 4px 18px rgba(239, 68, 68, 0.18)`) to attract new users.

### Changed
- **Trademark Icon Replacement (Zero Legal Risk)** — Replaced all trademarked Apple logo vectors across the app with generic open-source smartphone outline SVGs (`<rect x="6" y="2" width="12" height="20" rx="2"/>`) to ensure zero trademark or copyright liabilities for commercial distribution.
- **Shortcuts Port & HTTP Target Protocol Sync** — Corrected shortcut target URL protocol to `http://` and port to `3479` (`http://<PC-IP>:3479`) to bypass self-signed SSL warnings. Dynamically bound `$$('.infoShortcutUrlText')` in `public/app.js` to populate the user's active IP and port `3479` at runtime.
- **Unified Sober Dark Glass Aesthetics** — Streamlined all setup modals, cards, and buttons into a clean monochromatic dark glass palette (`#ffffff` typography and `#94a3b8` muted labels), reserving amber highlighting exclusively for security certificate warnings.
- **QR Cards Clean Grid Display** — Removed paragraph subtext descriptions and redundant buttons from shortcut QR cards for a clean, distraction-free layout.
- **Pairing & Fallback `/m` Path Suffix** — Appended `/m` path suffix to fallback link banner and pairing address (`https://<PC-IP>:<PORT>/m`) in HTML and dynamic JS binders.

### Fixed
- **App Version Sync Discrepancy** — Resolved root causes where Settings panels displayed outdated version strings (`v6.4.3` / `v6.2.16`). Added `id="appVersionTag"` in `public/index.html` and `id="mobileInfoAppVersion"` in `public/mobile.html` with dynamic JS DOM binding to ensure 100% accurate sync with `package.json` (`6.4.70`).

---

## [6.4.6] - 2026-08-15

### Added
- **Live In-App Download Progress Overlay (`#mobileDownloadProgressModal`)** — Displays real-time download progress (`%`, `MB / Total MB`) and real-time transfer speed (`⚡ MB/s`) right inside the Mobile PWA app for 300MB+ transfers.
- **Master Modal Sweep (`closeAllMobileModals`)** — Automatically dismisses all underlying preview lightboxes (video, image, music player) when starting downloads or completing file saves in the iOS Share Sheet.

### Fixed
- **iOS PWA QuickLook Black Screen Prevention** — Routed file attachments through invisible iframe triggers (`#hiddenDownloadIframe`) to prevent iOS WebKit from navigating top-level PWA windows to Apple's black QuickLook screen (`Open in "VLC"`).
- **Video Player Lightbox Download Action** — Resolved nested URL path parsing (`path=...`) so tapping download in the video player lightbox smoothly launches the live download progress overlay.
- **Icon-Only Round Action Buttons** — Redesigned lightbox modal action buttons into clean, uncluttered round icon buttons (`48px × 48px`).

---

## [6.4.5] - 2026-08-15

### Fixed
- **Auto-Updater Release Asset Alignment** — Explicitly configured `"artifactName": "${productName}.Setup.${version}.${ext}"` in `package.json` to guarantee that GitHub `latest.yml` manifests match release installer names (`AiroDrop.Setup.6.4.5.exe`) on GitHub Releases.
- **Multi-Candidate Asset Probing** — Added `resolveDirectAssetFallback` with fast HTTP `HEAD` probing across candidate filenames to ensure update downloads succeed cleanly across all previous client versions (`v6.4.3`, `v6.4.4`).
- **Relative Redirect Downloader Fix** — Enhanced `src/directDownloader.js` to resolve relative redirect headers and cap redirect depth to 10.

---

## [6.4.4] - 2026-08-15

### Added
- **PC Dashboard UI Redesign (iOS Liquid Glass Theme)** — Major overhaul of the PC dashboard status cards, action controls, and feed view:
  - **Service Active Glass Card**: Translucent liquid glass card background with crisp high-contrast typography, glowing green active status dot, and elegant faded color server action buttons (`Start`, `Restart`, `Stop`, `Kill`).
  - **Windows Explorer Details List View**: Sleek 48px Details layout for Received Feed items with aligned columns for file type, original filename, size badge, and quick hover actions.
  - **Top-Right Hover Card Clear Button**: Faded red circular `✕` button on the upper side of each feed card (revealed on hover) allowing users to clear individual cards from the feed UI without deleting physical files from disk.
  - **Reordered Feed Controls**: Updated header control bar featuring a compact Directory Icon button, List/Grid view toggle, and 360° animated Refresh button.
- **Standalone Download Webpage & External Browser Escape**:
  - Automatically converts received files in Recent Transfers into standalone download webpage URLs (`/files/download-page?files=...`).
  - Added Android System Intent escape (`intent://...`) and native `<a>` out-of-scope link navigation (`target="_blank" rel="noopener noreferrer"`) so tapping "Open Browser" breaks out of PWA containers directly into system web browsers (Chrome, Safari, Opera).
  - Webpage forced attachment download (`Content-Disposition: attachment`) ensures direct file downloads to mobile device folders without inline streaming.

### Changed
- **Temp Mode Storage Isolation** — Incoming uploads when Temp Mode is active route strictly to `temp_received/` and are kept isolated from `downloads/` until explicitly saved by the user.
- **Permanent File Saving** — Refactored `POST /api/save-file` with candidate path search and disk verification (`fs.existsSync`) before state updates.
- **Card Clear Server Synchronization** — Updated `DELETE /api/history/:id?keepFile=true` to dismiss items from server history state without unlinking files on disk, preventing cleared cards from reappearing on subsequent save operations or history syncs.

### Fixed
- **iOS Shortcuts File Upload Bug** — Resolved `ReferenceError: prefix is not defined` in Case 2 raw binary upload handler and enabled `upload.any()` with endpoint aliases `/api/clipboard` and `/api/clipboard/file`.

---

## [6.4.3] - 2026-08-13

### Added
- **1-Tap Android PWA Installation** — Added a prominent green 1-Tap **Install App Now** button inside the Android Setup modal (`#btnTriggerPwaInstall`) that directly triggers Chrome's native `beforeinstallprompt` PWA installation dialog.
- **Dynamic Audio Stream Animations** — Added distinct visual active state animations for live audio streams:
  - **PC Audio**: Live bouncing 3-bar green equalizer with pulsing `audioWaveGlow` aura.
  - **Mic Stream**: Red soundwave sonar/radar expansion ring animation (`micRadarExpand`) with pulsing `micWaveGlow` aura.
- **Categorized Mobile Settings Page** — Structured `#tabSettings` into 3 clean, Fluent Dark category cards:
  1. **🖥️ PC Host & Storage**: Displays PC Hostname, App Version (`v6.4.3`), and active PC Shared Folder storage path.
  2. **⚡ Network & Shortcuts**: Displays Local IP Address, HTTPS Web Service Port (3478), Shortcuts Direct Sync Port (3479), and direct companion setup action buttons.
  3. **👤 About Creator**: Developer branding card with View Creator Profile modal launcher.

### Changed
- **Subtext Descriptions Cleanup** — Removed redundant text labels and subtitle paragraphs across all Tools and Media tab buttons for a clean, vertically-centered interface.
- **Mobile Setup Modals Streamlining** — Removed redundant Quick Connection steps and Troubleshooting sections from iOS and Android setup modals for a focused installation guide flow.
- **PWA Service Worker Update** — Bumped Service Worker version to `v6.4.3` to ensure instant client cache refresh across all active mobile PWA installations.

### Fixed
- **Mic Stream Color Reset** — Fixed `stopMicStreaming()` and error handler routines to explicitly restore the subtle dark orange glass background (`rgba(255, 106, 0, 0.1)`) and border (`rgba(255, 106, 0, 0.3)`) when microphone streaming is stopped.

---

## [6.4.2] - 2026-08-13

### Added
- **Mobile File Manager (Tools Tab)** — New File Manager card in the Tools tab with a fullscreen iframe overlay to browse, upload, download, and manage PC shared folder files directly from the mobile PWA.
- **Separate Apple & Android Setup Pages** — Split the mobile setup overlay into two dedicated platform pages (`#mobileAppleSetupOverlay` and `#mobileAndroidSetupOverlay`) accessible from the Settings tab, each with platform-specific PWA installation guides and iOS Shortcuts quick install links.

### Changed
- **Settings Page Redesign** — Renamed "Connection Settings" to "Setup Mobile Companion". Removed Host PC Updater. Moved Server Diagnostics inline into the first settings card. Redesigned all settings buttons to a unified 46px height with 14px border-radius glass styling.
- **iOS Shortcut Buttons** — Enlarged shortcut buttons from 42px to 58px with distinct per-button color schemes: orange (Send to PC), purple (Clipboard), and cyan (Get to iOS). Icons scaled from 14px to 18px.
- **Emoji-Free Interface** — Removed all decorative emoji characters from settings, setup overlays, troubleshooting panels, and download warnings. Replaced with semantic SVG vector icons throughout.
- **File Manager Title** — Renamed `files.html` header from "PC Shared Folder" to "File Manager" with "PC Shared Folder" as contextual subtitle.
- **Compact Button Design** — All settings page buttons (Apple iOS Setup, Android Setup, View Creator Profile) use full-width layout with consistent glass morphism styling.

### Fixed
- **File Manager Duplicate UI** — Removed redundant overlay header that caused double-title display. The iframe now uses `files.html`'s own sticky header with its built-in close button via `postMessage('closeFileBrowser')`.
- **Setup Modal Event Wiring** — Rewired `initMobileSetupModal()` to correctly bind open/close/action handlers for the new split Apple and Android setup overlays, replacing stale single-modal selectors.

---

## [6.4.1] - 2026-08-13

### Added
- **Win32 Native Virtual Key Event Dispatch (`keybd_event`)** — Re-engineered VLC Media Player remote control in `src/vlcController.js` using `keybd_event` and `SetForegroundWindow` from `user32.dll` via Koffi. Synthesizes physical hardware modifier key events (`Ctrl`, `Alt`, `Shift`) to accurately execute 10-second, 1-minute, and 5-minute seek jumps in VLC.
- **Universal Sticky Top Bar Lock (`position: fixed`)** — Anchored the mobile PWA top title header (`AiroDrop Mobile`) permanently to the top of the viewport frame (`position: fixed; top: 0; left: 0; right: 0; z-index: 1000`) with glassmorphic backdrop blur (`backdrop-filter: blur(20px)`), safe-area inset protection, and precise content offset padding so the header never shifts during scrolling or browser bar transitions.
- **Immediate Touchstart Haptic Engine (`triggerHaptic`)** — Added a universal `touchstart` event delegate across all interactive elements (`button`, `.bottom-nav-item`, `.btn-control-cmd`, `.btn-vlc-cmd`, `input[type="range"]`, `.switch`). Enables instant tactile haptics on touch down, with dual-state WebKit Taptic Engine switch toggling for iOS 18+ and native `navigator.vibrate` for Android.

### Changed
- **Mobile UI Shuttle Slider Range** — Updated the VLC fast seek slider markers to `-5m`, `-1m`, `Neutral`, `+1m`, and `+5m` to match true hardware hotkey execution.
- **Theme-Aligned Play / Pause Controls** — Redesigned PC System Media and VLC Media Player Play / Pause buttons with AiroDrop's signature warm orange gradient (`linear-gradient(135deg, #ff6a00, #ff8533)`) and glowing drop shadow.
- **Clean Toast Feedback** — Removed repetitive action toast popups (`Triggered: volume_up`, `Left Click`, `Right Click`, etc.) on playback controls and trackpad gestures for silent, zero-distraction remote operation.

### Fixed
- **VLC Window Detection & Termination** — Case-insensitive title matching in `findVlcWindow()` ensures idle VLC instances (`VLC media player`) are detected and closed reliably via `WM_CLOSE` and `taskkill /IM vlc.exe /F`.
- **Mobile Viewport Rubber-Banding** — Fixed header shifting on iOS Safari and mobile Chrome during rapid scrolling and momentum gestures.

---

## [6.4.0] - 2026-08-12

### Added
- **Windows 11 Fluent Desktop Settings GUI** — Redesigned desktop Settings window into a native Windows 11 Fluent interface with dedicated navigation pages, dark glass styling, and vibrant orange theme accents.

### Changed
- **Dedicated Navigation Architecture** — Converted settings sub-tabs to dedicated navigation pages with smooth sidebar transitions.
- **Desktop Window Constraints** — Optimized default launch resolution and proportioned settings window layout (840x680).

### Fixed
- **Clean Settings Layout** — Removed deprecated activity log modals, cleaned up sidebar device cards, and fixed header settings gear icon button behavior.

---

## [6.3.3] - 2026-08-12

### Added
- **In-App Direct Binary Downloader (`src/directDownloader.js`)** — Native HTTP/HTTPS stream downloader with redirect handling and real-time speed & percentage progress tracking directly in the Update Hub.
- **Dynamic Release Asset Resolver (`getReleaseAssetUrl`)** — Queries GitHub API for the exact setup or portable `.exe` asset download URL attached to the release tag.

### Changed
- **System Tray Update Check** — Right-clicking the system tray icon and clicking **"Check for Updates..."** now automatically restores the main window, brings it into focus, and navigates directly to the Settings tab.
- **Vector Icons** — Replaced raw emoji characters in the Update Hub buttons with clean, crisp SVG vector icons.

### Fixed
- **Electron Preload Whitelist** — Added `start-download-update`, `quit-and-install-update`, and `navigate-tab` to `preload.js` security channel whitelist so button click events fire properly.
- **Real-Time Speed Calculation** — Fixed `0 MB/s` download speed display by calculating real-time chunk delta speed in `directDownloader.js`.

---

## [6.3.2] - 2026-08-12

### Added
- **Multi-File Selection & Download Page** — Added Select Mode to File Manager allowing users to check multiple files and generate a dynamic download webpage (`/files/download-page?files=...`).
- **Auth Token Passthrough** — Embedded active device auth tokens into download page URLs (`&token=...`) so Safari and Chrome can open download pages and file links without requiring re-authentication.

### Changed
- **Polished Standalone Download Page** — Redesigned the download page UI with a dark glassmorphism layout, AiroDrop logo from `/logo.png`, summary stat bar (file count, total size, local network), per-file extension badges, and copyable download links.
- **Selection Bottom Bar UI** — Polished selection bar with a vibrant count pill badge (`.sel-badge`), dynamic label (`.sel-label`), and gradient `Get Download Link` action button.
- **Long-Press Multi-Select Gesture** — Touch long-press (500ms) on any file item automatically enters Select Mode and selects that file.

### Fixed
- **PWA Copy Link Toast Feedback** — Fixed missing `#toast` element in `mobile.html` and updated `.toast` `z-index` to `10000000` so visual toast acknowledgments ("Copied to clipboard!") pop up over all full-screen modals.
- **DOM Tree Nesting Bug** — Fixed an unclosed `downloadInfoOverlay` container in `files.html` that caused fixed bottom bars and modals to inherit `display: none`.

---

## [6.3.1] - 2026-08-12

### Added
- **Confirmation Warning Dialogs** — Added a system confirmation modal for remote PC Power Off, Sleep, and VLC app closure to prevent accidental execution from the mobile UI.
- **Dynamic VLC Header Action Button** — VLC Media Player header button dynamically converts into a Refresh button when VLC is not running, and restores to a Close VLC button (with warning dialog) when VLC is active.

### Changed
- **Thicker VLC Shuttle Seek Slider** — Increased seek slider track thickness to 14px and thumb handle diameter to 28px with a 3px solid border and active scale effect for touchscreen ergonomics.
- **Bypassed Rate Limiter for Shuttle Seek** — Configured shuttle seek slider to bypass command rate limiting (`bypassRateLimit: true`) for aggressive real-time seeking while holding the slider.
- **Simplified VLC Control Labels** — Renamed "Cycle Audio Tracks" to "Change Audio" and cleaned up technical terminology into plain English across the mobile player UI.
- **Icon-Only Power Control Buttons** — Streamlined Power Controls card with clean SVG icon layout for Shut Down, Sleep, and Lock.

### Fixed
- **Mobile Viewport Touch Stabilization & Jitter Fix** — Fixed issue where rapid repeated button taps (e.g. Volume Up/Down) caused the mobile webpage to jump or scroll up/down. Implemented `touch-action: manipulation;`, `overscroll-behavior: none;`, in-memory rate guards (replacing DOM `btn.disabled` focus loss toggles), and a global double-tap gesture stabilizer.

---

## [6.3.0] - 2026-08-11

### Added
- **VLC Remote Controller** — FFI-based VLC Media Player remote control via `user32.dll` `PostMessageW`. Controls: play/pause, seek forward/backward (10s and 60s), volume up/down, mute, fullscreen toggle, subtitle cycling, and audio track switching. Real-time "Now Playing" HUD polls the active VLC window title from the mobile PWA.
- **VLC Controller backend module** (`src/vlcController.js`) — Enumerates Windows desktop windows via `EnumWindows` + `GetWindowTextW` using `koffi` FFI bindings, posts virtual key messages to the VLC window handle without requiring VLC's HTTP Lua interface.
- **VLC status API endpoint** (`GET /api/control/vlc-status`) — Returns `{ running, title }` for mobile clients to detect if VLC is active and display the current media title.
- **VLC action routing** — `POST /api/control` now routes all `vlc_*` actions (e.g. `vlc_play_pause`, `vlc_seek_forward_10s`) through `vlcController.sendVlcAction()` before falling through to existing system controls.
- **Mobile Home tab redesign** — Unified composer card with tabbed "Text / URL" and "File / Photo" send panels (replacing two separate sender cards). Added drag-and-drop file zone with upload icon, image preview, and file type icon.
- **Transfer History inbox** — Tabbed transfer history on Home tab with "Files" and "Text" filter tabs, replacing the old flat received list.
- **Mobile VLC controller panel** — Full remote control interface in the Media tab with play/pause, seek, volume, mute, fullscreen, subtitles, and audio track buttons. Conditionally hidden when VLC is not running, showing a placeholder instead.
- **Hold-to-seek jog shuttle slider** — Continuous seeking slider in the VLC controller that sends repeated seek commands based on drag distance (proportional acceleration).
- **PC System Controls repositioned** — Power controls (Lock, Sleep, Shutdown) moved to top of the mobile Tools tab for quicker access.
- **Emoji-to-SVG vector replacements** — Replaced all raw emoji characters in mobile.html with inline SVG vector icons for consistent cross-device rendering.

---

## [6.2.16] - 2026-08-01

### Added
- **High-speed cloud relay file streaming** — Increased file slice payload from 64 KB to 512 KB and implemented dynamic WebSocket backpressure (`relayWs.bufferedAmount < 2 MB`), allowing full 100Mbps+ speed utilization without timer delay caps.

---

## [6.2.15] - 2026-08-01

### Fixed
- **Screencast two-finger tap** — Properly registered multi-touch tracking (`scMaxTouches = 2`) so 2-finger tap triggers right click on remote desktop.
- **Screencast two-finger drag** — Deferred pinch-to-zoom mode activation so 2-finger vertical drag smoothly scrolls the remote desktop screen.

---

## [6.2.14] - 2026-07-22

### Added
- Visible download progress bar in Application Updates settings card (percentage, speed, transferred/total bytes)
- Distinct UI states for checking, downloading, ready-to-install, and error

---

## [6.2.13] - 2026-07-22

### Fixed
- **Auto-updater race condition** — Startup check delayed 10s so server config is fully loaded first
- **Update check timeout** — 30s timeout prevents infinite hangs on poor network; shows user-friendly message
- **Download failure handling** — Errors during download now surface a dialog and reset UI cleanly
- **Window crash on IPC send** — All `mainWindow.webContents.send` calls wrapped in destroyed-check guard
- **Semver comparison** — Both `/api/check-update` and Electron updater now compare versions numerically; dev builds ahead of remote no longer falsely trigger "update available"
- **`isManualCheck` state leak** — Timer and flag now properly reset on every check path (timeout, error, dialog dismiss)
- **Release workflow duplicate builds** — Removed `push: branches: main` trigger; releases now only created on `v*` tags or manual dispatch

### Added
- `autoInstallOnAppQuit` — Downloaded updates install silently on next app quit if user defers
- `/api/check-update` request timeout (15s) and GitHub rate-limit (429) handling
- `publishedAt` field in `/api/check-update` response
- Manual `workflow_dispatch` trigger with optional version override for CI releases

---

## [6.2.12] - 2026-07-22

### Removed
- Internal implementation plan files (`.kiro/plans/MASTER_IMPLEMENTATION_PLAN.md`, `.kiro/plans/PHASE1_SECURITY_HARDENING.md`)
- `Build Instructions Guide.md` (redundant with README, contained hardcoded local paths)

### Fixed
- LEGAL.md: Auth tokens table now accurately reflects that paired device tokens are stored on the PC in `paired_devices.json` (not browser-only)
- PRIVACY.md: Corrected authentication storage description to include server-side persistence

### Changed
- `.gitignore` updated to exclude `.kiro/` directory from version control

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
