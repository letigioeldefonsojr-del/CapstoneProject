// ====================================================================
// FIREBASE CONFIGURATION
// ====================================================================
// Get these values from: Firebase Console > Project settings (gear icon)
// > General tab > "Your apps" > SDK setup and configuration.
// This is the config for "Almares 328 Database".
// ====================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app-check.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBDu3L3v2iegBJbT618oQF0-_hwpiSXYn4",
  authDomain: "almares-328-database.firebaseapp.com",
  projectId: "almares-328-database",
  storageBucket: "almares-328-database.firebasestorage.app",
  messagingSenderId: "983672074863",
  appId: "1:983672074863:web:b1bb42ae617811e664939a"
};

export const app = initializeApp(firebaseConfig);

// App Check — verifies that requests reaching Firebase are genuinely
// coming from this real app (via reCAPTCHA v3 running in the
// background), not a script or bot pretending to be it. This is the
// SITE key, which is meant to be public — the actual SECRET key
// lives only inside Firebase Console (App Check settings), never in
// this file or anywhere in the client code.
//
// IMPORTANT: this only starts VERIFYING requests. It does nothing to
// actually block anything until "Enforce" is turned on per-product
// (Firestore, Authentication) in Firebase Console → App Check — leave
// that OFF (Monitor mode) until this is confirmed live and working.
initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider("6LfUv4AtAAAAANGvdRoLRJ_1XBf90wJBhxRq_keV"),
  isTokenAutoRefreshEnabled: true
});

export const auth = getAuth(app);
export const db = getFirestore(app);