# Google Cloud setup for BigBadPhotos (Drive + Photos + server worker)

One-time steps in https://console.cloud.google.com for the project that owns
your existing `GOOGLE_CLIENT_ID`.

## 1. Enable APIs
- APIs & Services → Library → enable **Photos Library API** (Drive API is already enabled).

## 2. Consent screen scopes
- APIs & Services → OAuth consent screen → Edit → Scopes → add:
  - `https://www.googleapis.com/auth/photoslibrary.appendonly`
  - `https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata`
- Keep the app in Testing mode and make sure your Google account is listed
  under **Test users** (avoids verification review; expect the "unverified app"
  interstitial once).

## 3. OAuth client
- APIs & Services → Credentials → your existing **Web application** client:
  - Authorized redirect URIs → add `http://localhost:8002/google/oauth/callback`
    (plus the port you actually run Flask on, if different).
  - Copy the **Client secret**.

## 4. Environment
Add to the project `.env` (never commit):

    GOOGLE_CLIENT_SECRET=<client secret>

Optional: `BBP_TOKEN_PATH=/custom/path/google_token.json` (default
`~/.bigbadphotos/google_token.json`, chmod 600).

## 5. Connect
Start Flask locally, sign in to BigBadPhotos, then visit
`http://localhost:8002/google/oauth/start` and approve. You land back on the
app with `?googleAuth=connected`. `/auth/config` now reports
`"serverGoogle": true` — Drive proxying, Photos export, and the autonomous
worker all run off the stored refresh token from then on.

Note: any signed-in BigBadPhotos user acts with the owner's stored Google
credentials — this is a single-owner deployment by design.
