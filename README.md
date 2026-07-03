# AiroDrop v3.0.1 🚀

A self-hosted local network alternative to Apple's AirDrop and Universal Clipboard. It allows you to transfer text, links, images, and files (PDFs, MP3s, ZIPs, etc.) from an iOS device to a PC over your local network.

![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-blue.svg?style=flat-square&logo=node.js)
![Platform Support](https://img.shields.io/badge/platform-windows%20%7C%20linux%20%7C%20macos-lightgrey.svg?style=flat-square)
![iOS Shortcuts](https://img.shields.io/badge/iOS%20Shortcuts-Supported-red.svg?style=flat-square&logo=shortcuts)
![License](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)

---

## 🖥️ Electron Desktop GUI Upgrade

AiroDrop has transitioned from a terminal-only command line utility to a beautiful, native **Desktop GUI Application**!

- **Floating UI Window:** Easily monitor, start, and stop the AiroDrop background server using a modern visual control panel.
- **System Tray Integration:** AiroDrop runs silently in your taskbar overflow menu. Left-click to show/hide the panel, or right-click to access quick server toggles and settings.
- **Autostart Boot Support:** Easily toggle "Launch on Startup" directly from the GUI settings.
- **Dynamic Local IP Resolution:** Instantly displays your exact local network IP address with a clickable link to open your dashboard instantly.
- **Interactive Directory Selector:** Select any save directory using a native Windows folder selection dialog.
- **Force Kill Switch:** A single-button process termination system built into the GUI to forcefully shut down all background subprocesses if needed.
- **Animated SVG Logo:** Features a smooth, pulsing radar animation indicating file-listening activity.

---

## How It Works

*   **Text & Links:** Sent directly to your PC's clipboard. Just press `Ctrl+V` to paste. If you share a webpage from iOS Safari, the server automatically parses the incoming HTML to extract and copy the clean target URL instead of raw HTML page source.
*   **Images:** Saved to your configured folder and copied directly to your PC's clipboard.
*   **Files (PDF, MP3, ZIP, etc.):** Saved to your configured directory automatically.
*   **Bi-directional Transfer:** Queue text or links on the PC dashboard to pull them onto your iPhone.

---

## Core Features

*   **Near-Zero Latency Clipboard Sync:** Copy text on your phone and instantly paste it on your PC.
*   **Bidirectional Sharing (PC ⇄ Mobile):** Send text, images, and arbitrary files (PDFs, MP3s, ZIPs, etc.) from PC to mobile directly using the Web Dashboard, and download them from the mobile setups page (`/m`).
*   **Interactive Multi-Theme UI:** Gorgeous responsive design featuring 5 themes: **Liquid Glass** (default with frosted glass effects and animated mesh background), **Dark Mode**, **Light Mode**, **Midnight Blue**, and **Aurora Green**.
*   **Premium Utilities:**
    *   **Statistics Panel:** Real-time metrics for total transfers, data size, server uptime, and active connection tracking.
    *   **Dashboard PIN Lock:** Secure access with an optional Access PIN lock screen.
    *   **History Export:** Download your entire transfer logs and details as a JSON file.
    *   **Storage Scan Indicator:** Tracks disk usage and file counts inside your save folder.
*   **Multi-Format File Support:** Support for transferring PDFs, MP3s, ZIPs, docx, or any file up to 50MB.
*   **Native System Clipboard Integration:** Transferred images are copied directly to your PC clipboard so they can be pasted immediately into Discord, Figma, Photoshop, or Word.
*   **System Notifications:** Desktop notifications inform you when files or clipboard text are received.

---

## Prerequisites

*   Both your PC and iOS device must be connected to the same local network subnet (same Wi-Fi).
*   **Node.js v18.0.0** or higher installed on your PC.

---

## Installation & Setup

If you wish to run the app as a developer:

1.  Clone this repository to your PC:
    ```bash
    git clone https://github.com/asepsayyad007/AiroDrop.git
    cd AiroDrop
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Run the application in Developer Mode:
    ```bash
    npm start
    ```

For compilation guidelines into custom installers and standalone binaries, check out the [Build Instructions Guide.md](Build%20Instructions%20Guide.md).

---

## iOS Shortcuts Configuration

Since newer iOS versions restrict third-party `.shortcut` downloads, configuring them manually takes under a minute.

### Shortcut 1: "Send to PC" (Share Sheet)
Allows sharing text, links, or documents directly from the share sheet of any app:
1.  Open the **Shortcuts** app on your iPhone/iPad and tap **+**.
2.  Tap the **ⓘ (info)** icon at the bottom, turn on **"Show in Share Sheet"**, and verify it accepts **Any** input.
3.  Add an **"If"** action.
4.  Tap the **"Shortcut Input"** variable inside the If action ➜ select **"File Extension"** ➜ set the condition to **"has any value"**.
5.  **Inside the "Then" block (when sharing a file):**
    *   Add **"Get Contents of URL"** ➜ URL: `http://<YOUR-PC-IP>:3478/api/send` ➜ Method: `POST` ➜ Request Body: `File` ➜ File: `Shortcut Input`.
6.  **Inside the "Else" block (when sharing text or web pages):**
    *   Add **"Get Contents of URL"** ➜ URL: `http://<YOUR-PC-IP>:3478/api/send` ➜ Method: `POST` ➜ Request Body: `Form` ➜ Add new Text Field ➜ Key: `content`, Value: `Shortcut Input`.
7.  Add a **"Show Notification"** action at the very end ➜ `"Sent to PC ✓"`.
   
### OR 

Click below link from your iPhone to install shortcut ( Share Sheet Shortcut )
iCloud link : `https://www.icloud.com/shortcuts/efd4af984d884e0eb8e8ba3ba319ce4d`

### Shortcut 2: "Send Clipboard" (Home Screen Widget)
One-tap widget on your Home Screen to upload whatever is in your phone's clipboard:
1.  Open the **Shortcuts** app and tap **+**.
2.  Add action: **"Get Clipboard"**.
3.  Add action: **"If"** ➜ choose **"Clipboard"** variable ➜ tap it and select **"File Extension"** ➜ set condition to **"has any value"**.
4.  **Inside the "Then" block (when copying a file/image):**
    *   Add **"Get Contents of URL"** ➜ URL: `http://<YOUR-PC-IP>:3478/api/send` ➜ Method: `POST` ➜ Request Body: `File` ➜ File: `Clipboard`.
5.  **Inside the "Else" block (when copying text/links):**
    *   Add **"Get Contents of URL"** ➜ URL: `http://<YOUR-PC-IP>:3478/api/send` ➜ Method: `POST` ➜ Request Body: `Form` ➜ Add new Text Field ➜ Key: `content`, Value: `Clipboard`.
6.  Add action: **"Show Notification"** ➜ `"Clipboard sent ✓"`.

### OR 

ClipboardToPc ( Text & Image only) ( Home screen widget )
iCloud link : `https://www.icloud.com/shortcuts/1f341cd7a57041958a87ce92f8acaa8b`


---

## Configuration (`config.json`)

Configuration is managed via `config.json` inside your system's user data directories, protecting write privileges:
```json
{
  "saveDir": "./received",
  "port": 3478,
  "temporaryMode": false,
  "deviceName": "My PC",
  "accessPin": ""
}
```
*   `saveDir`: Path to save received images and files.
*   `port`: Port the local server listens on.
*   "temporaryMode": Temporarily store files (deleted after 2 hours).
*   `deviceName`: Name shown on mobile guides and headers.
*   `accessPin`: Numeric PIN lock screen restriction.

---

## Troubleshooting

### Connection Timeout on iOS
*   Verify AP isolation is disabled in your router settings.
*   Authorize Node.js through the Windows Defender Firewall.

---

## Creator & License
Created by **Asep Sayyad** | GitHub: [github.com/asepsayyad007](https://github.com/asepsayyad007)

Released under the **MIT License**.
