# Turning Silence into a real Windows app

This makes a proper **Silence Setup 2.1.0.exe** installer (and a portable
`Silence 2.1.0 portable.exe` that needs no installation).
Everything below happens on your PC in the folder `C:\Users\rshre\Desktop\silence`.

---

## First: why your Google account came with the app

Nothing was copied into the installer. Electron keeps **all** browser data —
cookies, sign-in, history, bookmarks, installed extensions — outside the app
folder, in:

```
C:\Users\rshre\AppData\Roaming\Silence\
```

Your development copy and the app you packaged had the **same name**, so they
shared that one folder. The packaged app simply opened the profile you were
already signed into. It looked like your account "shipped with" the app.

**The fix is already in this build.** `main.js` now picks its data folder like this:

| You run | Data lives in |
|---|---|
| `npm start` (development) | `%APPDATA%\Silence` — your current data, untouched |
| the packaged app | `%APPDATA%\Silence-App` — clean and separate |

So the app you build from now on starts empty unless you choose otherwise.
(If you ever *want* the packaged app to inherit your data: before its first
launch, copy `%APPDATA%\Silence` to `%APPDATA%\Silence-App`.)

---

## 0. One-time requirements

* **Node.js 18 or newer** — <https://nodejs.org> (LTS installer, accept defaults).
  Check with: `node -v`
* ~2 GB free disk space and an internet connection for the first build
  (Electron + Windows signing/NSIS tooling is downloaded once, ~250 MB).

---

## 1. Install dependencies (only needed once per folder)

Open **PowerShell or CMD** in `C:\Users\rshre\Desktop\silence` and run:

```bat
npm install
```

This installs Electron, electron-builder and the three runtime packages
(`@ghostery/adblocker-electron`, `cross-fetch`, `electron-chrome-extensions`).
You have never run this before — that is why `node_modules` is missing today.

---

## 2. Reset the profile (optional, but do it before a build you share)

Double-click **`clean-profile.bat`** in this folder. It renames
`%APPDATA%\Silence` to `Silence-backup-<date>`, so the app you build starts
completely clean while your old data stays safely in the backup folder.

Or from inside the browser: **⚙ Settings → Privacy & security → Clear browsing
data → All time → Cookies + site data, Passwords, Cache**, then sign out of
Google.

---

## 3. Build

```bat
npm run dist
```

That is the whole command. You can also double-click **`build-windows.bat`**,
which runs the install step and the build step and then opens the output folder.

Other variants:

```bat
npm run dist:installer   rem only the Setup .exe
npm run dist:portable    rem only the single-file portable .exe
```

First build: 3–10 minutes (downloads + compresses). Later builds: ~1 minute.

---

## 4. Collect your app

```
dist\Silence Setup 2.1.0.exe     ← double-click installer (Start menu + desktop shortcut)
dist\Silence 2.1.0 portable.exe  ← one file, runs from a USB stick, installs nothing
```

Both are self-contained: ~150–220 MB for the installer, ~180 MB portable.

---

## 5. Test that it is clean

1. Run the installer, launch Silence from the desktop icon.
2. Open `silence://store` — no extensions, and you are **not** signed into Google.
3. Check the folder `C:\Users\rshre\AppData\Roaming\Silence-App` — it is the
   only place the app writes. Delete it to factory-reset the app at any time.

---

## Things you will notice

* **SmartScreen:** an unsigned app shows *"Windows protected your PC"*. Click
  **More info → Run anyway**. This is normal for self-built apps; removing it
  requires a code-signing certificate (~₹8,000/year from a CA).
* **Size:** Electron always bundles Chromium, so ~150 MB is the floor.
* **Updates to the app itself:** just rebuild and reinstall; the browser's own
  extensions keep updating themselves from Google's update service every 6 hours.

---

## If a build fails

| Message | Fix |
|---|---|
| `'npm' is not recognized` | Install Node.js and open a **new** terminal |
| `Cannot find module 'electron'` | Run `npm install` first |
| Downloads stall / `ETIMEDOUT` | Bad network. Retry, or set a mirror: `npm config set electron_mirror https://npmmirror.com/mirrors/electron/` |
| `Cannot create symbolic link` | Run the terminal as **Administrator**, or enable Windows Developer Mode |
| App opens to a blank screen | Run `node check-silence.js` and paste me the output |

---

## Advanced: force any data folder

```bat
set SILENCE_USERDATA=D:\SilenceProfile
npm start
```

…or copy `%APPDATA%\Silence` to that folder first to move your whole profile.

---

## Optional: a real icon

The build uses `icon.ico` (generated from `icon.jpg`). For a sharper result,
save a 256×256 PNG and run:

```bat
npx electron-icon-builder --input=my-icon.png --output=build
```
