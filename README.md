# Quiet Cycle

A period tracker that stays on your phone. No account, no cloud, no ads, no data resale.

- **Support:** https://kiddkevin00.github.io/quietcycle/
- **Privacy:** https://kiddkevin00.github.io/quietcycle/privacy.html

## Why this exists

The biggest free period trackers run ads, share with advertisers, and store your cycle on their servers. Quiet Cycle is a deliberate counterweight — local-only storage, no network requests, no account.

## Stack

Expo SDK 54, React 19.1, RN 0.81, TypeScript, expo-haptics, AsyncStorage.

## Local dev

```sh
npm install
npx expo start --tunnel
```

## App Store checklist

- [done] Bundle id `com.markutilitylabs.quietcycle`, display name, version — `app.json`
- [done] Privacy + Support URLs live (see top)
- [you] Apple Developer, Xcode 17+ or EAS, App Store Connect listing, **"Data Not Collected"** nutrition labels (literally true)

## License

MIT — see `LICENSE`.
