# AiroDrop v6.3.2

![AiroDrop Banner](banner.png)

A beautiful, self-hosted local network alternative to Apple's AirDrop and Universal Clipboard. AiroDrop allows you to seamlessly transfer text, links, images, and files between iOS/Android devices and your Windows PC over Wi-Fi — plus remote control your PC and stream your screen directly to your mobile webapp.

---

Official Website **[AiroDrop](https://airodrop.site/)** | Portfolio **[Asep Sayyad](https://asepsayyad007.in/)**

![Version](https://img.shields.io/badge/version-6.3.2-orange.svg?style=flat-square)
![Privacy](https://img.shields.io/badge/Privacy-Zero_Data_Retention-green.svg?style=flat-square)
![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-blue.svg?style=flat-square&logo=node.js)
![Platform Support](https://img.shields.io/badge/platform-windows-blue.svg?style=flat-square&logo=windows)
![iOS Shortcuts](https://img.shields.io/badge/iOS%20Shortcuts-Supported-red.svg?style=flat-square&logo=shortcuts)
![License](https://img.shields.io/badge/license-Proprietary-red.svg?style=flat-square)

---

## Downloads (v6.3.2)

Get the latest pre-compiled binaries for Windows:
* **[Download Setup Installer (v6.3.2)](https://github.com/asepsayyad007/AiroDrop/releases/download/v6.3.2/AiroDrop.Setup.6.3.2.exe)** — Standard Windows wizard installation.
* **[Download Portable Version (v6.3.2)](https://github.com/asepsayyad007/AiroDrop-Portable-6.3.2.exe)** — Standalone execution without installation.

For a detailed history of changes, see the [CHANGELOG.md](CHANGELOG.md).

---

## How It Works

* **Instant Clipboard Sync:** Copying text or sharing images on your phone pushes them to your PC's clipboard (Ctrl+V) instantly. Shared links from Safari/Chrome have clean URLs extracted automatically.
* **Bi-directional Queue:** Push links or text snippets from your PC dashboard to the mobile portal inbox, or download files directly onto your phone.
* **File Browser:** Open `http://<PC-IP>:<PORT>/files` in Safari to browse, upload, download, and manage files on your PC's shared folder.
* **Live Screencast:** Tap "Open Live Screen" on the mobile portal to stream your PC desktop at ~15fps with optional interactive mouse control.

---

## Core Features

* **Auto Clipboard Sync (iPhone → PC):** Text or images sent from your iPhone Shortcut are automatically synced with your PC clipboard. Just send on iPhone and paste (Ctrl+V) where you want.
* **HTTP File Browser:** Mobile-first file manager served at `/files`. Browse, upload (up to 4 GB), download, rename, delete, create folders. Works in any browser — no app required.
* **Remote Trackpad & Keyboard:** Full touchpad gesture support: move cursor, left/right click, double-click, 2-finger scroll, and real-time keyboard typing sync.
* **Live PC Screencast:** Stream your PC desktop to your phone at ~15fps. Interactive mode lets you tap and drag directly on the stream to control your PC.
* **Universal Connection:** Unified connection state management. Connect on portal load, with auto-reconnect fallback and status indicators.
* **PC Remote Control Utilities:** Lock your PC, trigger Sleep mode, or perform a clean Power Off directly from your phone.
* **Statistics & Storage Metrics:** Monitor total uploads, file counts, server uptime, and storage limits.
* **Security PIN Lock:** Optional Access PIN lock screen to protect your sharing dashboard on shared local networks.
* **Desktop Notifications:** Native bubble/banner notifications alert you when text, links, or images are received.
* **Native-grade PWA (Progressive Web App):** Add to Home Screen on iOS and Android. Offline fallback and service worker caching.
* **VLC Remote Controller:** Control VLC Media Player directly from your phone — play/pause, seek (10s/60s), volume, mute, fullscreen, subtitles, and audio track switching. Auto-detects when VLC is running and displays the current media title.
* **5 Distinct Themes:** Sunset (default), Dark, AMOLED, Nord, and Dracula.

---

## Prerequisites

* Both your PC and mobile device must be connected to the same local network subnet (Wi-Fi).
* **Node.js v18.0.0** or higher installed on your PC.

---

## Installation & Setup (Developer Mode)

To run or modify the app locally:

1. **Clone this repository:**
   ```bash
   git clone https://github.com/asepsayyad007/AiroDrop.git
   cd AiroDrop
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Run in Development Mode:**
   ```bash
   npm start
   ```

*To package the application into standalone installers (`.exe` or portable), run `npm run build`.*

---

## Using the File Browser

1. Open the AiroDrop PC dashboard &rarr; click **"Setup / Connect"** &rarr; go to the **"Files App / Browser"** tab to see your URL.
2. On your iPhone/Android, open **Safari or Chrome** and navigate to: `http://<YOUR-PC-IP>:<PORT>/files`
3. Browse your PC's shared folder, tap any file to **download** it to your phone, or tap **＋** to **upload** files.
4. Long-press any file/folder for rename and delete options.

---

## Using Live Screencast

1. On your phone, open the mobile portal → scroll to **PC Live Screen** → tap **"Open Live Screen"**.
2. If PC services are not connected, the page will auto-connect for you in the background.
3. The fullscreen overlay opens with a live ~15fps stream of your PC desktop.
4. Toggle **"View Only"** → **"Interactive"** to enable tap-to-click and drag-to-move-mouse control.
5. **Pinch to zoom** with 2 fingers (up to 5×). Drag with 1 finger to pan when zoomed in. Tap "Reset Zoom" button to restore.
6. **Landscape mode:** Rotate your phone for a wider view — the screencast fills the full screen with no UI bleed-through.
7. **Typing on your PC:** Tap the keyboard icon to open the text sync panel. In landscape mode, the QWERTY rows auto-hide so the video stays visible while you type.

---

## iOS Shortcuts & REST API Configuration

Easily share content directly from any iOS App Share Sheet or Home Screen widget, or integrate via REST API.

> **Authentication & Secret Key:**
> If Security Mode is enabled or an **iOS Shortcut Secret** is configured on PC, pass your secret in every HTTP request as a header: `X-AiroDrop-Token: <your_secret>` or append `?token=<your_secret>` to the URL. Use port `3479` (HTTP fallback port) for iOS Shortcuts to bypass self-signed SSL warnings.

### Shortcut 1: "Send to PC" (Share Sheet)
**Quick Install Link:** [Get Share to PC Shortcut](https://www.icloud.com/shortcuts/bd3ef813f57d435e8e7d3d1823b13ad8)

### Shortcut 2: "Send Clipboard" (Home Screen Widget)
**Quick Install Link:** [Get Clipboard Shortcut](https://www.icloud.com/shortcuts/3e39fa6cad3147019dc905e96994b1e6)

### Shortcut 3: "Get From PC" (Receive Text & Files)
**Quick Install Link:** [Get From PC Shortcut](https://www.icloud.com/shortcuts/1698d917c5a3447abea2fa506d7b1dac)

### Quick Install QR Codes
| 1. Share to PC | 2. Send Clipboard | 3. Get From PC |
| :-: | :-: | :-: |
| ![Share to PC](https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=https://www.icloud.com/shortcuts/bd3ef813f57d435e8e7d3d1823b13ad8) | ![Send Clipboard](https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=https://www.icloud.com/shortcuts/3e39fa6cad3147019dc905e96994b1e6) | ![Get From PC](https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=https://www.icloud.com/shortcuts/1698d917c5a3447abea2fa506d7b1dac) |

### REST API Endpoints
* **`POST /api/send`**: Send form text (`content=hello`) or raw binary file body. Header: `X-AiroDrop-Token`.
* **`GET /api/clipboard`**: Fetch current active text or pending transfer item. Header: `X-AiroDrop-Token`.
* **`POST /api/pending/:id/ack`**: Acknowledge receipt of a queued transfer item. Header: `X-AiroDrop-Token`.

---

## Configuration (`config.json`)

Settings are stored in `<App Data Directory>/AiroDrop/config.json`. Key configuration parameters:

* `port`: Server listening port (default: `3478`).
* `deviceName`: The hostname shown to mobile clients.
* `rateLimitEnabled`: Enable connection rate limiting (default: `true`).
* `notificationsEnabled`: Trigger Windows desktop alerts for incoming transfers (default: `true`).
* `temporaryMode`: Discard session files automatically after client disconnects (default: `false`).
* `saveDir`: Target download path for transferred items.
* `shareDir`: Root shared path exposed to the HTTP File Browser.

---

## Credits & Authors

AiroDrop is created and maintained by **[Asep Sayyad](https://asepsayyad007.in/)**. You can explore the project details and links on the **[AiroDrop Hub](https://airodrop.site/)**.

---

## License

This project is proprietary and confidential. All rights reserved.
