# AiroDrop 🚀
*An elegant, native PC-to-iPhone integration tool.*

AiroDrop turns your Windows/Linux PC into a seamless receiver and sender for your iPhone, functioning similarly to Apple's AirDrop. It allows you to instantly transfer text, URLs, and files over your local network. 

With its recent massive overhaul, AiroDrop is now a **fully-fledged Desktop GUI application** powered by Electron!

## ✨ New Features & Capabilities

- **Native GUI Interface:** Say goodbye to the terminal! AiroDrop now features a beautiful, floating window with clear Start/Stop controls and status indicators.
- **System Tray Integration:** AiroDrop runs silently in your taskbar. Close the main window to hide the app out of the way. Right-click the tray icon for quick actions, or left-click it to instantly summon the control window.
- **Automatic Startup:** Easily toggle "Launch on Startup" directly from the UI, so your PC is always ready to receive files the moment it turns on.
- **Custom Directory Selection:** Don't want your files cluttering the default folder? You can now use the native file picker in the app to select exactly where received images and documents should be saved.
- **Instant IP Linking:** As soon as the server boots, it automatically detects your correct Local Area Wi-Fi/Ethernet IP and provides a clickable link to instantly open your web dashboard.
- **Smart Persistent Storage:** Settings and History are safely stored in your system's User Data directory (e.g., `%APPDATA%\AiroDrop`), completely avoiding restrictive `Program Files` permission errors.
- **Animated SVG Logo:** Enjoy a smooth, pulsing radar animation when you open the control center!

## 📦 Distribution Formats

AiroDrop can be built and distributed in two convenient formats for Windows:
1. **The Setup Wizard (Installer):** A professional NSIS installation wizard that installs the app, registers uninstallers, and places a shortcut squarely on your Desktop.
2. **The Portable Executable:** A single `.exe` file you can carry on a USB stick or run from any folder without needing administrative installation.

## 🛠 Building It Yourself

If you'd like to modify the source code and compile your own executables, we've provided detailed instructions! Please check out the [Build Instructions Guide](build_instructions.md) for step-by-step commands on how to run `electron-builder`.

## 📱 How It Works (The iOS Shortcut)

The magic of AiroDrop relies on an iOS Shortcut on your iPhone. 
1. Open the Web Dashboard (by clicking the IP link in the app).
2. Scan the QR code to instantly install the customized iOS Shortcut onto your phone.
3. Select any photo or text on your phone, tap "Share", and select your AiroDrop shortcut to blast it straight to your PC!

---
*Built with Node.js, Express, and Electron.*
