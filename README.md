# AiroDrop v4.5.0 🚀

A beautiful, self-hosted local network alternative to Apple's AirDrop and Universal Clipboard. AiroDrop allows you to seamlessly transfer text, links, images, and files (PDFs, MP3s, ZIPs, etc.) between iOS/Android devices and your Windows PC over Wi-Fi, control your computer remotely, and mount it as a local network drive.

![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-blue.svg?style=flat-square&logo=node.js)
![Platform Support](https://img.shields.io/badge/platform-windows%20%7C%20linux%20%7C%20macos-lightgrey.svg?style=flat-square)
![iOS Shortcuts](https://img.shields.io/badge/iOS%20Shortcuts-Supported-red.svg?style=flat-square&logo=shortcuts)
![License](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)

---

## 🚀 What's New in v4.5.0

AiroDrop has received a massive feature and visual upgrade:

1. **📺 Live Remote Screencast:** Stream your PC's desktop directly onto your phone's trackpad gesture area! You can move the mouse cursor and interact with your PC right on top of the live video feed.
2. **📱 Native-grade PWA (Progressive Web App):** Fully compatible with iOS "Add to Home Screen" and Android app installs. Features offline fallback support (`offline.html`) and intelligent asset caching via a custom service worker (`sw.js`).
3. **📁 Seamless WebDAV File Sharing:** Mount your PC's shared folder directly in the native **iOS Files App** (via "Connect to Server") or Android file managers (CX File Explorer, Solid Explorer, Samsung My Files, etc.). Download, upload, rename, and manage files up to **5+ GB** instantly over the local network.
4. **🎨 Sunset Glassmorphism UI:** Brand-new glowing warm orange/red theme alignment matching the custom sunset-droplet SVG logo. Includes dynamic animations, frosted glass styling, and 5 distinct themes.
5. **💻 Premium Desktop Wrapper:** Tray icon integrations, native startup boot support, and automated taskbar icon resolution on Windows.

---

## How It Works

* **Text & Links:** Copying text on your phone pushes it to your PC's clipboard (Ctrl+V) instantly. Shared links from Safari/Chrome have clean URLs extracted automatically.
* **Images:** Saved to your configured folder and copied directly into your PC's clipboard memory (ready to paste in Discord, Photoshop, Word, or Slack).
* **Files:** Documents, archives, audio, or video files are organized and saved automatically to your PC's local storage.
* **Bi-directional Queue:** Push links or text snippets from your PC dashboard to the mobile portal inbox, or download files directly onto your phone.

---

## Core Features

* **Near-Zero Latency Clipboard Sync:** Instantly sync clipboard buffers bidirectionally.
* **PC Remote Control Utilities:** Lock your PC, trigger Sleep mode, or perform a clean Power Off directly from your phone.
* **Statistics & Storage Metrics:** Monitor total uploads, file counts, server uptime, and storage limits.
* **Security PIN Lock:** Optional Access PIN lock screen to protect your sharing dashboard on shared local networks.
* **Desktop Notifications:** Native bubble/banner notifications alert you when text, links, or images are received.

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

*To package the application into standalone installers (`.exe` or portable), see the [Build Instructions Guide.md](Build%20Instructions%20Guide.md).*

---

## iOS Shortcuts Configuration

Easily share content directly from any iOS App Share Sheet or Home Screen widget.

### Shortcut 1: "Send to PC" (Share Sheet)
Allows sharing text, links, or documents from the iOS Share Sheet:
1. Open the **Shortcuts** app on your iPhone/iPad and tap **+**.
2. Tap the **ⓘ (info)** icon, turn on **"Show in Share Sheet"**, and verify it accepts **Any** input.
3. Add an **"If"** action.
4. Tap the **"Shortcut Input"** variable inside the If action ➜ select **"File Extension"** ➜ set the condition to **"has any value"**.
5. **Inside the "Then" block (when sharing a file):**
   * Add **"Get Contents of URL"** ➜ URL: `http://<YOUR-PC-IP>:3478/api/send` ➜ Method: `POST` ➜ Request Body: `File` ➜ File: `Shortcut Input`.
6. **Inside the "Else" block (when sharing text or web pages):**
   * Add **"Get Contents of URL"** ➜ URL: `http://<YOUR-PC-IP>:3478/api/send` ➜ Method: `POST` ➜ Request Body: `Form` ➜ Add new Text Field ➜ Key: `content`, Value: `Shortcut Input`.
7. Add a **"Show Notification"** action at the very end ➜ `"Sent to PC ✓"`.
   
**Quick Install Link:**
[Get Share to PC Shortcut](https://www.icloud.com/shortcuts/efd4af984d884e0eb8e8ba3ba319ce4d)

### Shortcut 2: "Send Clipboard" (Home Screen Widget)
One-tap widget to upload whatever is in your phone's clipboard:
1. Open the **Shortcuts** app and tap **+**.
2. Add action: **"Get Clipboard"**.
3. Add action: **"If"** ➜ choose **"Clipboard"** variable ➜ tap it and select **"File Extension"** ➜ set condition to **"has any value"**.
4. **Inside the "Then" block (when copying a file/image):**
   * Add **"Get Contents of URL"** ➜ URL: `http://<YOUR-PC-IP>:3478/api/send` ➜ Method: `POST` ➜ Request Body: `File` ➜ File: `Clipboard`.
5. **Inside the "Else" block (when copying text/links):**
   * Add **"Get Contents of URL"** ➜ URL: `http://<YOUR-PC-IP>:3478/api/send` ➜ Method: `POST` ➜ Request Body: `Form` ➜ Add new Text Field ➜ Key: `content`, Value: `Clipboard`.
6. Add action: **"Show Notification"** ➜ `"Clipboard sent ✓"`.

**Quick Install Link:**
[Get Clipboard Shortcut](https://www.icloud.com/shortcuts/1f341cd7a57041958a87ce92f8acaa8b)

### 📲 Quick Install QR Codes
Scan these QR codes with your iPhone's camera to install the shortcuts directly:

| 1. Share to PC | 2. Send Clipboard |
| :-: | :-: |
| ![Share to PC](https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=https://www.icloud.com/shortcuts/efd4af984d884e0eb8e8ba3ba319ce4d) | ![Send Clipboard](https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=https://www.icloud.com/shortcuts/1f341cd7a57041958a87ce92f8acaa8b) |

---

## Configuration (`config.json`)

Configuration is managed via `config.json` inside your system's user data directory:
```json
{
  "saveDir": "C:\\path\\to\\save",
  "port": 3478
}
```
* `saveDir`: Path to save received images and files on your PC.
* `port`: Port the local network server listens on (default is `3478`).

---

## Creator & License
Created by **Asep with Love ❤️** | GitHub: [github.com/asepsayyad007](https://github.com/asepsayyad007)

Released under the **MIT License**.
