# Stämpelklockan

Clock in, lunch and clock out from the phone. Calculates hours and overtime per
pay period (26th to 25th). Each person signs in with email and password and only
sees their own hours.

Backend: Firebase project `job-hour-tracker` (Authentication + Cloud Firestore).

## Files

- `index.html`, `app.js`: the app
- `sw.js`, `manifest.webmanifest`, `icon-*.png`: home screen install and offline start
- `firestore.rules`: security rules (each user can only read and write their own data)
- `firebase.json`, `.firebaserc`: lets the Firebase CLI deploy auth settings and rules

## Data in Firestore

```
users/{uid}                  target, lunch, updatedAt
users/{uid}/days/{YYYY-MM-DD} date, clockIn, clockOut, lunch, updatedAt
```

## Setup

1. Firebase console → Authentication → Sign-in method → enable **Email/Password**.
2. Firebase console → Firestore Database → create a database if none exists.
3. Firestore → Rules → paste the contents of `firestore.rules` → **Publish**.
4. Upload all files in this folder to the root of a public GitHub repo.
   Settings → Pages → Deploy from a branch → `main` / `(root)`.

With the Firebase CLI, steps 1 and 3 can instead be done with:

```
npx -y firebase-tools@latest deploy --only auth,firestore:rules
```
