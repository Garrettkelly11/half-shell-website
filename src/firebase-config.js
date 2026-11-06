/**
 * Firebase Configuration & Initialization
 * The one copy of the web config, loaded by index.html, curated-flights.html
 * and employee.html. src/passport-store.js keeps its own copy on purpose: it
 * starts a separately named app ("passport") so a guest's sign-in never
 * touches the menu's connection.
 */

const firebaseConfig = {
  apiKey: "AIzaSyDNuyGuzAmow0YehKlztihYn3l57--82L8",
  authDomain: "half-shell-oyster-menu.firebaseapp.com",
  databaseURL: "https://half-shell-oyster-menu-default-rtdb.firebaseio.com",
  projectId: "half-shell-oyster-menu",
  storageBucket: "half-shell-oyster-menu.firebasestorage.app",
  messagingSenderId: "784452175310",
  appId: "1:784452175310:web:2d56ed01d06bb39886179f"
};

/**
 * Subresource integrity for the Firebase SDK files the pages load from
 * gstatic: the browser refuses a file whose contents don't match. Change
 * these together with the SDK version. To get a hash:
 *   curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A
 */
const FIREBASE_SRI = {
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js': 'sha384-ajMUFBUFMCyjh8uxJg6bkGcKe9RTolyjwbxB3yES0QQMenP3Oztj/W9vA2SJPcIh',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js': 'sha384-f6/UpzjTjIXASlp20cArQsaRh1EvHVJd5kegy/gYR9W2D0a32TnEqUEiW4Zm/5O0'
};

/** A <script> for a Firebase SDK file, with its integrity hash when known. */
function firebaseScript(src) {
  const script = document.createElement('script');
  script.src = src;
  if (FIREBASE_SRI[src]) {
    script.integrity = FIREBASE_SRI[src];
    script.crossOrigin = 'anonymous';
  }
  return script;
}

/**
 * Initialize Firebase and return database reference
 * Call this function to set up Firebase in any page
 */
async function initializeFirebase() {
  return new Promise((resolve) => {
    // Load Firebase SDKs dynamically (non-blocking)
    const scripts = [
      'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
      'https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js'
    ];

    let loaded = 0;
    scripts.forEach((src) => {
      const script = firebaseScript(src);
      script.onload = () => {
        loaded++;
        if (loaded === scripts.length) {
          firebase.initializeApp(firebaseConfig);
          resolve(firebase.database());
        }
      };
      script.onerror = () => {
        console.error(`Failed to load Firebase script: ${src}`);
        resolve(null); // Resolve with null if Firebase fails to load
      };
      document.head.appendChild(script);
    });
  });
}

/**
 * Get the menu serving reference
 * Used by both index.html and employee.html
 */
function getMenuServingRef(db) {
  return db ? db.ref('menu/serving') : null;
}

/**
 * Export for use in other scripts
 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    firebaseConfig,
    initializeFirebase,
    getMenuServingRef
  };
}
