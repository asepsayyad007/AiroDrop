# iOS Shortcut Setup Guide — Complete Instructions

This guide walks you through creating two iOS Shortcuts that let you send images and text from your iPhone to your PC with a single tap, using the native Share Sheet.

> **Prerequisites:**
> - Your PC must be running the AirDrop-to-PC server (`npm start`)
> - Both your iPhone and PC must be on the **same Wi-Fi network**
> - You need your PC's local IP address (shown in the dashboard and server terminal)
> - Replace `<PC-IP>` below with your actual IP (e.g., `192.168.1.42`)

---

## Shortcut 1: "Send to PC" (Share Sheet Shortcut)

This shortcut appears in the Share Sheet of **any app** — Photos, Safari, Notes, Files, etc. It automatically detects whether you're sharing an image or text and sends it to the correct endpoint.

### Step 1: Open the Shortcuts App

1. Find the **Shortcuts** app on your iPhone (it has a red/pink icon with overlapping colored squares)
2. If you can't find it, swipe down on your Home Screen and search for "Shortcuts"
3. The Shortcuts app is **built into iOS** — no download needed

### Step 2: Create a New Shortcut

1. Tap the **+** (plus) button in the top-right corner of the Shortcuts app
2. This creates a new blank shortcut with the default name "New Shortcut"
3. Tap on the shortcut name at the top to rename it to **"Send to PC"**

### Step 3: Configure as a Share Sheet Shortcut

This is the critical step that makes the shortcut appear when you tap the Share button in any app:

1. Tap the **down-arrow (ⓘ)** at the top of the shortcut editor, just below the shortcut name
2. In the shortcut details panel that slides up, find **"Show in Share Sheet"**
3. Toggle it **ON** (it should turn green/blue)
4. Tap on **"Share Sheet Types"** below it
5. Select the following types:
   - **Images** (for photos, screenshots, downloaded images)
   - **Text** (for copied text, notes, URLs)
   - **URLs** (for web links)
6. Tap **Done** in the top-right corner to close the details panel

> **What this does:** Your shortcut will now appear as an option whenever you tap the Share button (the square with an arrow pointing up) in any app that shares images, text, or URLs.

### Step 4: Add "Receive Any Input" Action

1. At the top of your shortcut, you should see **"Shortcut Input"** in a gray bubble
2. Tap on it
3. In the action picker that appears, the **"Receive Any input"** action should already be selected (since you configured Share Sheet types)
4. If you see options like "Images", "Text", "URLs" — select **"Any"** to accept all input types
5. This means the shortcut can handle anything thrown at it

### Step 5: Add the "If" Conditional Block

Now we need to tell the shortcut to branch depending on whether the input is a file (Image, PDF, MP3, ZIP, etc.) or plain text:

1. Tap anywhere below the "Shortcut Input" action to add a new action.
2. Search for **"If"** in the action search bar and select it.
3. Configure the condition:
   *   **Input:** Tap the first parameter and choose **"Shortcut Input"**
   *   **Modify Attribute:** Tap the **"Shortcut Input"** block *again* inside the action ➜ scroll down and select **"File Extension"**.
   *   **Condition:** Change the condition parameter to **"has any value"** (or **"is not empty"** in older iOS versions).

> **The If block should read:** `If File Extension has any value` (representing any file like PDF, MP3, PNG, ZIP, etc.)

### Step 6: Add the File Upload Action (Then Block)

Inside the **"Then"** section of the If block (runs when the input is a file):

1. Tap inside the **"Then"** section to add an action.
2. Search for **"Get Contents of URL"** and select it.
3. Configure it as follows:
   - **URL:** `http://<PC-IP>:3478/api/send` (replace `<PC-IP>` with your PC's actual local IP)
   - **Method:** Tap "GET" and change it to **"POST"**
   - **Request Body:** Tap "None" and change it to **"File"**
   - **File:** Tap "File" and select the **"Shortcut Input"** variable.

### Step 7: Add the Text Upload Action (Else Block)

Inside the **"Else"** section of the If block (runs when the input is NOT an image, i.e., text or link):

1. Tap inside the **"Else"** section to add an action.
2. Search for **"Get Contents of URL"** and select it.
3. Configure it as follows:
   - **URL:** `http://<PC-IP>:3478/api/send`
   - **Method:** Tap "GET" and change it to **"POST"**
   - **Request Body:** Tap "None" and change it to **"Form"**
   - **Form Values:** Tap **Add new field** ➜ choose **Text** field:
     - **Key:** `content`
     - **Value:** Select the **"Shortcut Input"** variable.

> **What this does:** When you share an image, link, or text from any app, the shortcut automatically branches: images are sent as a raw binary file, and text/links are sent as a form text field. The server processes both formats dynamically, writing text directly to your PC clipboard and saving images directly to your PC Desktop.

### Step 6: Add a Confirmation Notification

1. Tap below the action to add a new action.
2. Search for **"Show Notification"** and select it.
3. Configure it:
   - **Title:** "Send to PC"
   - **Message:** "Sent to PC ✓"
   - **Play Sound:** Toggle ON (optional)

### Step 7: Test the Shortcut

1. **Test with text:** Select text in any app (Notes, Safari, etc.) ➜ tap **Share** ➜ tap **"Send to PC"** ➜ verify the text is instantly copied to your PC clipboard.
2. **Test with an image:** Open Photos ➜ select a photo ➜ tap **Share** ➜ tap **"Send to PC"** ➜ check your PC Desktop's `AirDrop-Received/` folder and clipboard.

---

## Shortcut 2: "Send Clipboard" (Home Screen Widget)

This shortcut sends whatever is currently on your iPhone's clipboard to your PC. You can add it as a Home Screen widget for one-tap access — no need to open any app first.

### Step 1: Create a New Shortcut

1. Open the **Shortcuts** app
2. Tap **+** to create a new shortcut
3. Name it **"Send Clipboard"**

### Step 2: Get Clipboard Content

1. Tap to add your first action
2. Search for **"Get Clipboard"**
3. Select it

> **What this does:** This action reads whatever text is currently stored in your iPhone's clipboard (whatever you last copied).

### Step 3: Add the "If" Conditional Block

1. Tap below the Get Clipboard action.
2. Search for **"If"** in the action search bar and select it.
3. Configure the condition:
   *   **Input:** Tap and choose **"Clipboard"**
   *   **Modify Attribute:** Tap the **"Clipboard"** block *again* inside the action ➜ scroll down and select **"File Extension"**.
   *   **Condition:** Change to **"has any value"** (or **"is not empty"**).

### Step 4: Add the File Upload Action (Then Block)

Inside the **"Then"** section of the If block:

1. Tap inside **"Then"** ➜ add **"Get Contents of URL"**.
2. Configure it:
   - **URL:** `http://<PC-IP>:3478/api/send`
   - **Method:** **"POST"**
   - **Request Body:** **"File"**
   - **File:** Select the **"Clipboard"** variable.

### Step 5: Add the Text Upload Action (Else Block)

Inside the **"Else"** section of the If block:

1. Tap inside **"Else"** ➜ add **"Get Contents of URL"**.
2. Configure it:
   - **URL:** `http://<PC-IP>:3478/api/send`
   - **Method:** **"POST"**
   - **Request Body:** **"Form"**
   - **Form Values:** Tap **Add new field** ➜ choose **Text** field:
     - **Key:** `content`
     - **Value:** Select the **"Clipboard"** variable.

### Step 4: Add Confirmation Notification

1. Add a **"Show Notification"** action.
2. Set the message to **"Clipboard sent ✓"**.

### Step 5: Add to Home Screen as Widget

Now make it accessible from your Home Screen with one tap:

#### Option A: Add as Home Screen Icon (simple)

1. In the Shortcuts app, tap the **down-arrow (ⓘ)** on your "Send Clipboard" shortcut
2. Tap **"Add to Home Screen"**
3. You can customize the icon and name:
   - **Name:** "Send Clipboard" (or "→ PC" for brevity)
   - **Icon:** Tap the icon to choose a color/glyph (e.g., an arrow, a clipboard icon)
   - **Color:** Pick a distinctive color so it's easy to find
4. Tap **"Add"** in the top-right
5. The shortcut now appears on your Home Screen — tap it anytime to send your clipboard

#### Option B: Add as a Widget (more prominent)

1. Long-press on an empty space on your Home Screen
2. Tap the **+** (plus) button in the top-left corner
3. Scroll down to find **"Shortcuts"** and tap it
4. Choose a widget size:
   - **Small:** Shows one shortcut as a single tap button
   - **Medium:** Shows up to 4 shortcuts
5. Tap **"Add Widget"**
6. After placing the widget, tap it to configure which shortcut it runs
7. Select **"Send Clipboard"**

> **Usage:** Copy any text on your iPhone (e.g., a phone number, address, link, snippet from an article), then tap the Home Screen widget. The text instantly appears on your PC's clipboard.

---

## Creating a "Receive from PC" Shortcut (Two-Way)

Since the dashboard supports sending content from PC to iPhone, you can create a shortcut that checks for pending items:

### Step 1: Create "Check PC" Shortcut

1. Create a new shortcut named **"Check PC"**
2. Add **"Get Contents of URL"**:
   - **URL:** `http://<PC-IP>:3478/api/pending`
   - **Method:** **"GET"**
3. Add **"Get Dictionary from Input"** (to parse the JSON)
4. Add **"Get Dictionary Value"** → key: `"items"`
5. Add **"Repeat with Each"** (to loop through items)
6. Inside the repeat, add an **"If"** to check the item type
7. For text items: add **"Copy to Clipboard"**
8. For image items: add **"Save to Photo Album"**
9. After processing, add a **notification** showing what was received

### Step 2: Add to Home Screen

Add this shortcut to your Home Screen the same way as "Send Clipboard". Whenever you tap it, it checks if your PC has sent anything and processes it.

---

## Troubleshooting

### "Shortcut Input" or "Clipboard" not appearing as a variable
When setting the File parameter in the URL actions, make sure to tap the variable suggestion that appears above the keyboard (e.g., "Shortcut Input" or "Clipboard"). If you don't see it:
- Make sure you configured "Show in Share Sheet" correctly in Step 3
- Try deleting the "Get Contents of URL" action and re-adding it

### Connection refused / request failed
- Ensure your PC server is running (`npm start`)
- Both devices must be on the **same Wi-Fi network** (not cellular data)
- Double-check the IP address matches what's shown in the server terminal
- If your router uses AP isolation, disable it in your router settings

### Image not saving
- Check that `~/Desktop/AirDrop-Received/` folder exists (the server creates it automatically)
- Ensure the image format is supported (JPG, PNG, GIF, WebP, HEIC, BMP, SVG)
- Maximum file size is 50 MB

### Shortcut not appearing in Share Sheet
- Go to Settings → Shortcuts → ensure "Allow Untrusted Shortcuts" is ON
- Make sure "Show in Share Sheet" is toggled ON in the shortcut details
- Try sharing from a different app (Photos, Safari, Notes)
- Restart your iPhone if the shortcut still doesn't appear

### Widget not working
- Make sure the shortcut runs correctly when tapped from inside the Shortcuts app first
- iOS widgets sometimes have a slight delay on first use
- Remove and re-add the widget if it's unresponsive

---

## Quick Reference Card

| What | How |
|------|-----|
| Send photo to PC | Open Photos → Select → Share → "Send to PC" |
| Send text to PC | Select text in any app → Share → "Send to PC" |
| Send URL to PC | In Safari/any browser → Share → "Send to PC" |
| Send clipboard to PC | Copy anything → Tap "Send Clipboard" widget |
| Check for PC messages | Tap "Check PC" shortcut |
| Open dashboard | In Safari, go to `http://<PC-IP>:3478` |