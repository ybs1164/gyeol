# Android 0.4.1 / nickname input

Validated on 2026-11-16 (KST).

- Nickname inputs use a fixed 48 CSS pixel height in column forms, normal 400 font weight, and a single focus indicator. This fixes both onboarding and nickname editing.
- Android defaults to `wss://gyeol.146.56.189.166.sslip.io/ws` when no server is saved. Explicit server settings and `VITE_SERVER` retain precedence. Web browsers continue using their own origin.
- Android bundles local assets (`https://localhost`); no remote `server.url` was added.
- Android version name/code: `0.4.1` / `4`.

## Verification

- Four server URL regression tests passed; workspace type checking passed.
- Production web build and Capacitor sync passed.
- Browser onboarding and nickname editing passed at 390x844, 390x420 and 1440x1000. Input height 48, font weight 400, no horizontal overflow, visible focus indicator and successful name saves.
- Browser server authentication, AI first move and puzzle rendering passed.
- Android 16.1 debug APK: native platform confirmed, empty saved server, successful Oracle WSS welcome/login, nickname save, correct input appearance and no JavaScript exceptions.
- With airplane mode enabled and Wi-Fi disabled, the external health fetch failed as expected; AI played its first move and a puzzle rendered from bundled assets. Network settings were restored afterwards.
- Signed release and debug builds passed (`assembleRelease assembleDebug`). Release signature verified with `apksigner`; all bundled production files matched the web build byte for byte. Keystore and database files are absent from the APK.
- Signed release installed, rendered onboarding, accepted a nickname through Android input, and displayed `ReleaseCheck`, `Placement · 1500` and `0W 0L` after automatic Oracle login.

Evidence: `tools/apk-validation/{web-report.json,android-report.json,artifact.json,gradle-build.log}` and screenshots in that directory.

APK: `dist/GYEOL-0.4.1.apk` (6,246,211 bytes).

SHA-256: `98fa815e3daae7f7a66277a1ee4a6cfbafbccac011caab16c44f1f5f63b8007c`

The downloaded cloud APK was compared byte for byte with the signed local artifact. The cloud file expires 24 hours after upload; the local artifact remains available.

## Oracle web deployment

The live web still requires this static asset update because this workstation has no SSH private key. APK changes are already included in the artifact.

```sh
curl -fL https://paste.rs/sBwkf -o w
sudo python3 w
```

The downloader verifies SHA-256 before running the updater. The updater backs up overwritten files, keeps older hashed assets for existing clients, writes new assets before index/service worker files, checks server health and the served index, and restores files if validation fails. It preserves existing model/runtime assets, database files, application processes and Caddy settings. The update/retention/rollback behavior was checked in a temporary installation; the published download and SHA-256 were also checked under Linux. The updater payload expires 24 hours after upload.

Regenerate with `python tools/package_web_update.py` after a production build. Its output is `dist/gyeol-web-update.py`.

## Emulator environment

An isolated AVD on N: was used; existing AVD data was not modified. The installed command line tools initially wrote `target=android-0` for the API 36.1 image; correcting the test AVD target to `android-36.1` and disabling Vulkan resolved the SurfaceFlinger crash loop. This environment workaround is unrelated to application code. Full device testing used the debug APK; the release APK separately passed signing, asset comparison, installation, nickname entry and online login checks. No physical handset was connected.
