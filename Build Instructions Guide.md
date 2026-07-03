# AiroDrop Build Instructions Guide 🛠

This guide contains the detailed terminal commands and steps required to compile and build the AiroDrop application into Windows executables (`.exe`) yourself.

## Prerequisites
Before you can build the application, make sure you have the following installed on your Windows PC:
1. **Node.js** (v18 or higher recommended). Download from [nodejs.org](https://nodejs.org/).
2. **Git Bash** or **PowerShell** (built into Windows).

---

## Step 1: Open Terminal in Project Folder
Navigate to your AiroDrop project folder (`c:\Users\aseps\Downloads\AiroDrop`).
Open PowerShell and type:
```powershell
cd C:\Users\aseps\Downloads\AiroDrop
```

---

## Step 2: Install Dependencies
If this is your first time compiling or if you recently downloaded/modified the project, you must install the required dependencies (including Electron and the developer packaging tools).
Run:
```powershell
npm install
```

---

## Step 3: Run the Compilation Build
To compile the source code into the **Setup Installer** and the **Portable Executable**, run the following script:
```powershell
npm run build
```

This triggers `electron-builder`, which automatically:
- Obtains the correct Electron runtime packages.
- Packs the code securely into an ASAR archive.
- Generates your custom animated icons.
- Packages the native clipboard/notification drivers.
- Outputs the finalized executables to the `dist` folder.

---

## Step 4: Retrieve Your Executables
Once compilation finishes successfully, check the newly created `dist/` directory inside your project folder:
1. **`AiroDrop Setup 3.0.1.exe`** - The full setup wizard that installs AiroDrop to your PC, creates a Desktop shortcut, and registers an uninstaller.
2. **`AiroDrop-Portable-3.0.1.exe`** - A standalone single-file executable that runs immediately without installing anything.

---

## Developer Testing Mode
If you are modifying files and want to test changes instantly without waiting for a full packaging build, start the app in Developer Mode:
```powershell
npm start
```
