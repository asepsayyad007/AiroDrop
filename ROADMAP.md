# AiroDrop Feature Roadmap

This document outlines the planned advanced features for iPhone to PC integration. We will be implementing these one by one.

## 1. Live Shared Scratchpad
- **Goal**: A text box in the dashboard that syncs instantly with the iPhone.
- **Details**: Open the mobile web portal on the iPhone and see text appear as you type it on the PC. Perfect for drafting long messages, copying code snippets, or keeping a temporary list without needing to "send" discrete messages back and forth.
- **Status**: [x] Completed

## 2. PC Remote Control via iOS Shortcuts
- **Goal**: Allow the iPhone to trigger actions on the PC.
- **Details**: Add endpoints to `server.js` (like `/api/control/lock` or `/api/control/volume`). Create iOS Shortcuts (or widgets) on the iPhone to instantly lock the Windows PC, pause media, or mute the volume with a single tap.
- **Status**: [x] Completed

## 3. Smart Link "Casting"
- **Goal**: Instantly open links from the iPhone on the PC's default browser.
- **Details**: Add a toggle in the Tools tab: *"Auto-open received links in browser"*. When an iPhone sends a URL via the Share Sheet, it instantly pops open on the Windows desktop monitor instead of just copying to the clipboard.
- **Status**: [x] Completed

## 4. Fetch PC Screenshot
- **Goal**: Instantly grab the computer's screen from the phone.
- **Details**: Ping `server.js` to take a screenshot of the Windows desktop and instantly return the image to the iPhone's screen. Perfect for checking the status of long-running tasks.
- **Status**: [x] Completed

## 6. Remote Mouse & Keyboard Trackpad
- **Goal**: Turn the iPhone into a wireless trackpad and keyboard for the PC.
- **Details**: Add a specific "Trackpad" interface to the mobile web portal that captures touch events and keystrokes. Send these over WebSockets to `server.js` which uses a desktop automation library (like `robotjs`) to simulate physical OS-level mouse movements and keystrokes on the Windows PC with zero-latency.
- **Status**: [x] Completed

## 5. Native iOS "Files" App Integration (WebDAV)
- **Goal**: Map the PC's folder directly inside the iPhone's native "Files" app.
- **Details**: Spin up a lightweight WebDAV server alongside AiroDrop. On the iPhone, use "Connect to Server" in the Files app to browse, move, and edit PC files natively over local Wi-Fi.
- **Status**: [x] Completed
