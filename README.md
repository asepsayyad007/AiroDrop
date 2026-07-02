# AiroDrop

A self-hosted local network alternative to Apple's AirDrop and Universal Clipboard. It allows you to transfer text, links, images, and files (PDFs, MP3s, ZIPs, etc.) from an iOS device to a PC over your local network.

![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-blue.svg?style=flat-square&logo=node.js)
![Platform Support](https://img.shields.io/badge/platform-windows%20%7C%20linux%20%7C%20macos-lightgrey.svg?style=flat-square)
![iOS Shortcuts](https://img.shields.io/badge/iOS%20Shortcuts-Supported-red.svg?style=flat-square&logo=shortcuts)
![License](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)

---

## How It Works

*   **Text & Links:** Sent directly to your PC's clipboard. Just press `Ctrl+V` to paste. If you share a webpage from iOS Safari, the server automatically parses the incoming HTML to extract and copy the clean target URL instead of raw HTML page source.
*   **Images:** Saved to your configured folder and copied directly to your PC's clipboard.
*   **Files (PDF, MP3, ZIP, etc.):** Saved to your configured directory automatically.
*   **Bi-directional Transfer:** Queue text or links on the PC dashboard to pull them onto your iPhone.

---

## Core Features

*   **Near-Zero Latency Clipboard Sync:** Copy text on your phone and instantly paste it on your PC.
*   **Multi-Format File Support:** Support for transferring PDFs, MP3s, ZIPs, docx, or any file up to 50MB.
*   **Native System Clipboard Integration:** Transferred images are copied directly to your PC clipboard so they can be pasted immediately into Discord, Figma, Photoshop, or Word.
*   **Cross-Platform Native folder Picker:** Click "Browse..." on the settings panel in the dashboard to choose any folder on your PC using the native Windows, Linux, or macOS directory dialog.
*   **System Notifications:** Desktop notifications inform you when files or clipboard text are received.
*   **Responsive Web Dashboard:** Modern, clean interface to view transfer history, clear list, queue items for your phone, and update folder paths.

---

## Prerequisites

*   Both your PC and iOS device must be connected to the same local network subnet (same Wi-Fi).
*   **Node.js v18.0.0** or higher installed on your PC.

---

## Installation

1.  Clone this repository to your PC:
    ```bash
    git clone https://github.com/your-username/AiroDrop.git
    cd AiroDrop
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Start the local server:
    ```bash
    npm start
    ```
4.  Open the web dashboard in your browser: `http://localhost:3478`

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

---

## Configuration (`config.json`)

Configuration is managed via `config.json` in the project root:
```json
{
  "saveDir": "./received",
  "port": 3478
}
```
*   `saveDir`: Path to save received images and files (absolute or relative to project root).
*   `port`: Port the local server listens on.

You can modify `saveDir` dynamically from the Settings tab in the Web Dashboard. Clicking the **"Browse..."** button triggers a native directory picker window on the host OS.

---

## Troubleshooting

### Connection Timeout on iOS
*   Verify AP isolation is disabled in your router settings.
*   Authorize Node.js through the Windows Defender Firewall:
    1.  Open Windows Security ➜ Firewall & network protection.
    2.  Click **Allow an app through firewall** ➜ locate **Node.js JavaScript Runtime** ➜ make sure both **Private** and **Public** checkboxes are checked.

---

## License

MIT License.
