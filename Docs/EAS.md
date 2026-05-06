# EAS dev build — installable APK

Expo Go can't load native modules that need a config-plugin pass (e.g.
`expo-image-picker` permissions, `expo-audio` recording on Android, eventually
`react-native-quick-crypto`). The fix is an EAS dev build: a custom development
client APK that loads the JS bundle from `npx expo start --dev-client`.

This doc captures the one-time setup + the build/install loop. Don't run the
build from inside an autonomous session — it's ~15-20 min of EAS time and
incurs queue cost.

## One-time prerequisites

```bash
npm install -g eas-cli
eas login                         # requires an Expo account; reuse the jeemitsha one
cd app/
eas init                          # creates the project on Expo, writes the projectId into app.json
```

`eas init` will write a `projectId` into `app.json` under `extra.eas.projectId`.
Commit that — it's required for builds to attach to the right project.

## Producing a dev build

From `app/`:

```bash
# Builds the dev-client APK on EAS's Android queue.
eas build --profile development --platform android
```

What happens:

1. EAS uploads your project, runs `expo prebuild` against the bare workflow, applies
   all config plugins (`app.json` plugins[] block), and builds an APK.
2. Build takes ~15-20 min on the free tier; subscribers get faster queues.
3. When done, EAS prints a download URL + a QR. Scan the QR on the phone, or
   run `eas build:install` from the desktop.
4. Install the APK (you may need "install from unknown sources" on Android).
5. Open the APK — it shows an "Open project" screen instead of the splash. Run
   `npx expo start --dev-client --lan` on the Mac, then tap the URL on the phone.
   The app loads JS from your dev server with hot reload, just like Expo Go.

## Why `development` profile vs `preview` / `production`

- `development`: includes the Expo dev client (lets you hot-reload JS from the
  dev server). Use this for daily iteration once Expo Go is no longer enough.
- `preview`: packages the JS bundle inside the APK (no dev server). Good for
  sharing a single artifact for someone to test offline.
- `production`: same as preview but with `autoIncrement` so versions step on
  every build. Use when uploading to Play Store / sharing to a wider audience.

## Common pitfalls

- **`react-native-svg` linking**: should be auto-linked through Expo's prebuild,
  but if a dev build fails on Android with a `RNSVG` not found error, run
  `npx expo install --fix` to align the version.
- **Permissions**: any new permission (camera, microphone, photo library) must
  be declared in `app.json` plugins[] AND will trigger a permission prompt on
  first use. EAS dev builds need the package re-installed if you add a new
  permission — incremental dev-client APKs reuse the existing manifest.
- **Bundle identifier collisions**: if you ever fork to a different account,
  bump `ios.bundleIdentifier` and `android.package` in `app.json` so the new
  account can sign builds.
- **Out-of-date Expo Go**: when migrating off Expo Go, uninstall it from the
  phone first to avoid "which app should open expo://… ?" prompts.

## What changes for the dev loop

| Step | Expo Go | Dev build |
|---|---|---|
| Bundler | `expo start --lan` | `expo start --dev-client --lan` |
| Phone install | none (use Expo Go) | one-time APK install |
| New native module | reinstall dependency only | new EAS dev build needed |
| JS-only changes | auto reload | auto reload |

## Future: Play Store internal testing

Once the dev build is stable:

```bash
eas build --profile production --platform android
eas submit --platform android   # requires Google Play Console service account
```

Internal testing track lets you push APKs to a closed list of Google accounts
without going through the public store review.
