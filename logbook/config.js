// LogBook configuration
// ---------------------------------------------------------------------------
// DEVICE MODE (default): leave FIREBASE_CONFIG as null. Everything is stored on
// the phone/computer the app is opened on. Good for trying the app out, but a
// manager will only see hours entered on that same device.
//
// CLOUD MODE (for real crew use): paste the web config from your Firebase
// project below (see README.md, "Turn on syncing"). Every phone then syncs to
// one shared database, and still works with no signal in the woods: entries
// are saved on the phone and upload automatically when signal comes back.
// ---------------------------------------------------------------------------

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC4ns1BSXZX6uo7kKB2oY18OgUr_pxtCPY",
  authDomain: "santoros-logbook.firebaseapp.com",
  projectId: "santoros-logbook",
  storageBucket: "santoros-logbook.firebasestorage.app",
  messagingSenderId: "138722476738",
  appId: "1:138722476738:web:53d456834ccc9fe043315b",
};

// Manager "Reset PIN" in cloud mode needs the setPin function, which only runs
// on Firebase's pay-as-you-go (Blaze) plan. Leave false on the free plan.
// (Device-only mode can always reset PINs.)
export const PIN_RESET_ENABLED = false;

export const APP_NAME = "LogBook";
