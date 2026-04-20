/**
 * Firebase Configuration & Initialization
 * Shared across index.html and employee.html
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
      const script = document.createElement('script');
      script.src = src;
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
 * Get the audit log reference
 * Used by employee.html to log changes
 */
function getAuditLogRef(db) {
  return db ? db.ref('audit-log') : null;
}

/**
 * Export for use in other scripts
 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    firebaseConfig,
    initializeFirebase,
    getMenuServingRef,
    getAuditLogRef
  };
}
