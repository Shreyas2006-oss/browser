# Silence — security notes

This file answers the four findings from the audit of Silence and records what
is fixed, what is reduced, and what remains by design.

---

## 1. Host shell runs with Node  —  partially fixed, risk reduced

`main.js` creates the browser chrome with `nodeIntegration: true`,
`contextIsolation: false`, `webSecurity: false`. That combination means any
script that reaches the chrome's DOM runs with full filesystem rights, so the
defence is to keep page-supplied data out of the chrome's HTML.

**Fixed — the injection points are closed:**

| Path | Before | After |
|---|---|---|
| Tab titles | `innerHTML = ... ${t.title}` | `escHtml(t.title)` |
| Favicons | `src="${t.favicon}"`, any scheme | escaped, and only `https:` / `data:image/*` accepted |
| Download filenames | `innerHTML = ... ${item.filename}` (5 places) | `escHtml(item.filename)` — filenames come from `Content-Disposition`, i.e. from the server |
| Save-page dialog | raw suggested name | `safeDownloadName()` |
| Chrome itself | no policy | a Content-Security-Policy meta: `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, scripts limited to `'self'` |

Escaping happens in `escHtml()` / `isSafeIconUrl()` in `index.html`, and both
are installed before the first line of UI code.

**What remains:** the chrome still has Node. Truly removing that needs
`contextIsolation: true` plus a `contextBridge` preload exposing a small API —
a rewrite of the chrome's ~3 000 lines, and the reason it has not been done
blind. With every known injection point escaped, a page would now need a
genuinely new hole in the chrome's own code to get there.

## 2. Command injection  —  fixed

`install-cws-extension` used to run

```js
execSync(`tar -xf "${tempZip}" -C "${targetDir}"`)
execSync(`powershell ... '${tempZip}' ... '${targetDir}'`)
```

Both interpolated paths into a shell string. Now `extractArchive()` calls
`execFileSync` with an **argument array** — no shell is created, so `&`, `|`,
`;` or a backtick in a path is just a character. The extension id is also
checked against `/^[a-z0-9]{32}$/` before it is used to build any path, so it
cannot steer the write to another directory.

## 3. CSRF via cookie rewriting  —  fixed (narrowed)

The `SameSite=None; Secure` rewrite used to apply to **every** third-party
response. It now applies only when all of these hold:

1. the response is not the page's own main frame,
2. the URL is `https:`,
3. the host is on the sign-in allow-list (`accounts.google.com`,
   `microsoftonline.com`, `appleid.apple.com`, `github.com`, …), and
4. Settings → Privacy → **Fix embedded sign-in cookies** is on.

Everything else keeps Chromium's own SameSite policy, CSRF protection intact.

## 4. Chromium patch delay  —  mitigated

Silence inherits Chromium from Electron, so a zero-day lands when Electron
ships it. Two things now help:

* **15 seconds after launch** the app asks `registry.npmjs.org/electron/latest`.
  If the installed major is **2 or more behind**, you get a toast naming the
  current and latest versions and the command to run.
* **`npm run update-electron`** installs the newest Electron. Rebuild with
  `npm run dist` afterwards.

Silence is currently pinned to Electron **37.10.3** — that is
**Chromium 138.0.7204.35** / V8 13.8 (released June 2025).

For comparison, as of September 2026 the current line is Electron 44
(Chromium 152). Electron support policy keeps the newest three majors, so 42,
43 and 44 are supported; 41 and older are end-of-life. Being on 37 therefore
means roughly a year of Chromium security fixes are not in your build — which
is why this section exists.

---

## Update checklist

```
npm run update-electron      # newest Electron
npm run dist                 # rebuild the installer
```

Both are optional; nothing else changes when you run them.
