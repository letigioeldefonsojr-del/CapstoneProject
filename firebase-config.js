// ====================================================================
// FIREBASE CONFIGURATION
// ====================================================================
// Get these values from: Firebase Console > Project settings (gear icon)
// > General tab > "Your apps" > SDK setup and configuration.
// This is the config for "Almares 328 Database".
// ====================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
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
export const auth = getAuth(app);
export const db = getFirestore(app);
