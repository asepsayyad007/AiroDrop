# iOS Shortcut Setup Guide — Complete Instructions & REST API

This guide walks you through setting up or manually creating the three iOS Shortcuts to send images, files, and text between your iPhone and PC, as well as accessing the REST API endpoints.

> **Prerequisites:**
> - Your PC must be running the AirDrop-to-PC server (`npm start`)
> - Both your iPhone and PC must be on the **same Wi-Fi network**
> - You need your PC's local IP address (shown in the dashboard and server terminal)
> - Replace `<PC-IP>` below with your actual IP (e.g., `192.168.1.42`)
> - **Port Note:** Use port `3479` (HTTP fallback port) for iOS Shortcuts to bypass iOS self-signed SSL warnings.
> - **Security Secret Note:** If Security Mode is enabled or an iOS Shortcut Secret is configured on PC, pass the header `X-AiroDrop-Token: <your_secret>` or append `?token=<your_secret>` to all request URLs.

---

## Pre-made One-Tap Install Links

* **Shortcut 1: "Send to PC" (Share Sheet)** — [Download Shortcut 1](https://www.icloud.com/shortcuts/bd3ef813f57d435e8e7d3d1823b13ad8)
* **Shortcut 2: "Send Clipboard" (Home Widget)** — [Download Shortcut 2](https://www.icloud.com/shortcuts/3e39fa6cad3147019dc905e96994b1e6)
* **Shortcut 3: "Get From PC" (Receive Text & Files)** — [Download Shortcut 3](https://www.icloud.com/shortcuts/1698d917c5a3447abea2fa506d7b1dac)

*When setting up installed shortcuts, enter your PC IP address (e.g., `192.168.1.50`) and your iOS Shortcut Secret (if configured).*

---

## Manual Configuration Instructions

### Shortcut 1: "Send to PC" (Share Sheet Shortcut)

This shortcut appears in the Share Sheet of **any app** — Photos, Safari, Notes, Files, etc. It automatically detects whether you're sharing an image/file or text and sends it to your PC.

1. Open **Shortcuts** app ➜ tap **+** ➜ rename to **"Send to PC"**
2. Tap **ⓘ (Details)** ➜ enable **"Show in Share Sheet"** ➜ set Share Sheet Types to **Any**
3. Add action: **"If"** ➜ set Input: **Shortcut Input** ➜ Modify attribute to **File Extension** ➜ Condition: **"has any value"**
4. Under **Then** (Files / Images):
   - Add **"Get Contents of URL"**
   - **URL:** `http://<PC-IP>:3479/api/send` (or `http://<PC-IP>:3479/api/send?token=<your_secret>`)
   - **Method:** **POST**
   - **Request Body:** **File** ➜ File: **Shortcut Input**
   - **Headers:** Key: `X-AiroDrop-Token`, Value: `<Your iOS Shortcut Secret>`
5. Under **Else** (Text / Links):
   - Add **"Get Contents of URL"**
   - **URL:** `http://<PC-IP>:3479/api/send`
   - **Method:** **POST**
   - **Request Body:** **Form** ➜ Field `content`: **Shortcut Input**
   - **Headers:** Key: `X-AiroDrop-Token`, Value: `<Your iOS Shortcut Secret>`
6. Add **"Show Notification"** ➜ Message: `"Sent to PC ✓"`

---

### Shortcut 2: "Send Clipboard" (Home Screen Widget)

1. Open **Shortcuts** app ➜ tap **+** ➜ rename to **"Send Clipboard"**
2. Add action: **"Get Clipboard"**
3. Add action: **"If"** ➜ Input: **Clipboard** ➜ Modify attribute to **File Extension** ➜ Condition: **"has any value"**
4. Under **Then** (Files / Images):
   - Add **"Get Contents of URL"**
   - **URL:** `http://<PC-IP>:3479/api/send`
   - **Method:** **POST**
   - **Request Body:** **File** ➜ File: **Clipboard**
   - **Headers:** Key: `X-AiroDrop-Token`, Value: `<Your iOS Shortcut Secret>`
5. Under **Else** (Text / Links):
   - Add **"Get Contents of URL"**
   - **URL:** `http://<PC-IP>:3479/api/send`
   - **Method:** **POST**
   - **Request Body:** **Form** ➜ Field `content`: **Clipboard**
   - **Headers:** Key: `X-AiroDrop-Token`, Value: `<Your iOS Shortcut Secret>`
6. Add **"Show Notification"** ➜ Message: `"Clipboard sent ✓"`

---

### Shortcut 3: "Get From PC" (Receive Text & Download Files)

Fetches active text or files sent from PC dashboard to your iPhone.

1. Open **Shortcuts** app ➜ tap **+** ➜ rename to **"Get From PC"**
2. Add action: **"Get Contents of URL"**:
   - **URL:** `http://<PC-IP>:3479/api/clipboard`
   - **Method:** **GET**
   - **Headers:** Key: `X-AiroDrop-Token`, Value: `<Your iOS Shortcut Secret>`
3. Add **"Get Dictionary from Input"** ➜ Input: **Contents of URL**
4. Add **"Get Dictionary Value"** ➜ Key: `"success"`
5. Add **"If"** ➜ Condition: `"is true"`:
   - **Then (Valid Content):**
     - Add **"Get Dictionary Value"** ➜ Key: `"type"`
     - Add **"If"** ➜ Condition: `"is text"`:
       - **If Text:**
         - Add **"Get Dictionary Value"** ➜ Key: `"text"`
         - Add **"Copy to Clipboard"** ➜ Input: **Dictionary Value**
         - Add **"Get Dictionary Value"** ➜ Key: `"id"`
         - Add **"Get Contents of URL"** ➜ `http://<PC-IP>:3479/api/pending/<id>/ack` ➜ Method: **POST** ➜ Headers: `X-AiroDrop-Token: <your_secret>`
         - Add **"Show Notification"** ➜ `"Text copied to clipboard"`
       - **Otherwise (If File):**
         - Add **"Choose from Menu"** ➜ Prompt: `"Download File?"` ➜ Options: **Download**, **Cancel**
         - Under **Download**:
           - Add **"Get Dictionary Value"** ➜ Key: `"url"`
           - Add **"Get Contents of URL"** ➜ Input: `"url"` **Dictionary Value**
           - Add **"Get Dictionary Value"** ➜ Key: `"mimeType"`
           - Add **"If"** ➜ Condition: `"starts with image/ or video/"`:
             - **If Image/Video:** **"Save to Photo Album"** ➜ Input: downloaded **Contents of URL**
             - **Otherwise:** **"Save File"** ➜ Input: downloaded **Contents of URL**
           - Add **"Get Dictionary Value"** ➜ Key: `"id"`
           - Add **"Get Contents of URL"** ➜ `http://<PC-IP>:3479/api/pending/<id>/ack` ➜ Method: **POST** ➜ Headers: `X-AiroDrop-Token: <your_secret>`
           - Add **"Show Notification"** ➜ `"File downloaded successfully"`
   - **Otherwise (Empty state):**
     - Add **"Show Notification"** ➜ `"Clipboard is empty"`

---

## REST API Reference

You can call the server directly via cURL, Python, JS, or any HTTP client:

### 1. Send Text or File (`POST /api/send`)
- **URL:** `http://<PC-IP>:3479/api/send` (or port `3478`)
- **Headers:** `X-AiroDrop-Token: <your_secret>` (if secret is enabled)
- **Send Text (Form):**
  ```bash
  curl -X POST "http://<PC-IP>:3479/api/send" \
    -H "X-AiroDrop-Token: <your_secret>" \
    -d "content=Hello from cURL"
  ```
- **Send File (Raw Binary):**
  ```bash
  curl -X POST "http://<PC-IP>:3479/api/send" \
    -H "X-AiroDrop-Token: <your_secret>" \
    --data-binary "@photo.jpg"
  ```

### 2. Fetch Clipboard / Pending Item (`GET /api/clipboard`)
- **URL:** `http://<PC-IP>:3479/api/clipboard`
- **Headers:** `X-AiroDrop-Token: <your_secret>`
  ```bash
  curl "http://<PC-IP>:3479/api/clipboard" -H "X-AiroDrop-Token: <your_secret>"
  ```

### 3. Acknowledge Queue Item (`POST /api/pending/:id/ack`)
- **URL:** `http://<PC-IP>:3479/api/pending/<item_id>/ack`
- **Headers:** `X-AiroDrop-Token: <your_secret>`
  ```bash
  curl -X POST "http://<PC-IP>:3479/api/pending/<item_id>/ack" -H "X-AiroDrop-Token: <your_secret>"
  ```