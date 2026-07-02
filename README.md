# AiroDrop

A lightweight, self-hosted local network alternative to Apple's AirDrop and Universal Clipboard. It allows you to instantly transfer text, links, images, and files (PDFs, MP3s, ZIPs, etc.) from an iOS device to a PC over your local Wi-Fi.

## How it works
*   **Text & Links:** Copied directly to your PC's clipboard. Just press `Ctrl+V` to paste.
*   **Images:** Saved to a designated folder and copied directly to your PC's clipboard.
*   **Files (PDF, MP3, ZIP, etc.):** Saved to your designated folder.
*   **Bi-directional Transfer:** Queue text or links on the PC dashboard to pull them onto your iPhone.

---

## Features

*   **⚡ Near-Zero Latency Clipboard Sync:** Copy on iPhone, paste on PC instantly.
*   **📂 Multi-Format File Support:** Transfer PDFs, MP3s, ZIPs, or document formats up to 50MB.
*   **📋 Native Windows Clipboard Integration:** Images are copied directly to the clipboard so you can paste them straight into Discord, Figma, Photoshop, or Word.
*   **🎛️ Native PC Folder Picker:** Click "Browse..." on the settings tab to choose any destination folder on your PC using the native Windows/Linux directory picker.
*   **🔔 Desktop Notifications:** System notifications let you know when text or files have been received.
*   **💻 Local Web Portal:** Includes a responsive web interface to monitor history, manage pending clips, and configure server settings.

---

## Getting Started

### Prerequisites
*   Your PC and iOS device must be on the **same Wi-Fi network**.
*   **Node.js v18.0.0** or higher installed on your PC.

### Installation

1.  Clone the repository and install dependencies:
    ```bash
    git clone https://github.com/your-username/AiroDrop.git
    cd AiroDrop
    npm install
    ```
2.  Start the server:
    ```bash
    npm start
    ```
3.  Open the web dashboard in your PC browser: `http://localhost:3478`

---

## iOS Shortcuts Configuration

Since newer iOS versions restrict direct third-party `.shortcut` file installations, you can easily configure the Shortcuts app manually in under a minute.

### Shortcut 1: "Send to PC" (Share Sheet)
Allows you to share text, links, or documents from the iOS share sheet in any app:
1.  Open the **Shortcuts** app on your iPhone and tap **+**.
2.  Tap the **ⓘ (info)** icon at the bottom, turn on **"Show in Share Sheet"**, and verify it is set to accept **Any** input.
3.  Add an **"If"** action.
4.  Tap the **"Shortcut Input"** variable in the If action ➜ select **"File Extension"** ➜ set the condition to **"has any value"**.
5.  **Inside the "Then" block:**
    *   Add **"Get Contents of URL"** ➜ URL: `http://<YOUR-PC-IP>:3478/api/send` ➜ Method: `POST` ➜ Request Body: `File` ➜ File: `Shortcut Input`.
6.  **Inside the "Else" block:**
    *   Add **"Get Contents of URL"** ➜ URL: `http://<YOUR-PC-IP>:3478/api/send` ➜ Method: `POST` ➜ Request Body: `Form` ➜ Add new Text Field ➜ Key: `content`, Value: `Shortcut Input`.
7.  Add a **"Show Notification"** action at the very end ➜ `"Sent to PC ✓"`.

### Shortcut 2: "Send Clipboard" (Home Screen Widget)
One-tap widget on your Home Screen to send whatever is in your phone's clipboard:
1.  Open **Shortcuts** app ➜ tap **+**.
2.  Add action: **"Get Clipboard"**.
3.  Add action: **"If"** ➜ choose **"Clipboard"** variable ➜ tap it and change it to **"File Extension"** ➜ set condition to **"has any value"**.
4.  **Inside the "Then" block:**
    *   Add **"Get Contents of URL"** ➜ URL: `http://<YOUR-PC-IP>:3478/api/send` ➜ Method: `POST` ➜ Request Body: `File` ➜ File: `Clipboard`.
5.  **Inside the "Else" block:**
    *   Add **"Get Contents of URL"** ➜ URL: `http://<YOUR-PC-IP>:3478/api/send` ➜ Method: `POST` ➜ Request Body: `Form` ➜ Add new Text Field ➜ Key: `content`, Value: `Clipboard`.
6.  Add action: **"Show Notification"** ➜ `"Clipboard sent ✓"`.

---

## Configuration (`config.json`)

You can configure the server settings by creating a `config.json` file in the project root:
```json
{
  "saveDir": "./received",
  "port": 3478
}
```
*   `saveDir`: Path to save received images and files (absolute or relative to project root).
*   `port`: Network port to run the server on.

You can update `saveDir` dynamically at runtime directly from the Web Dashboard's Settings panel. Clicking **"Browse..."** will launch the native folder picker window on your host OS (supports Windows, Linux, and macOS).

---

## Troubleshooting

### Connection Times Out on iOS
*   **Verify Subnet:** Ensure your phone is not on a separate "Guest" network or AP isolation is active.
*   **Windows Firewall:** Make sure Node.js is authorized to receive private network traffic:
    1.  Open Windows Security ➜ Firewall & network protection.
    2.  Click **Allow an app through firewall** ➜ check **Node.js JavaScript Runtime** for both Private and Public networks.

---

## License

MIT License.
