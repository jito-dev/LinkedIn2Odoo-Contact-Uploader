/**
 * This script manages the "Odoo Connection" section of the options.html page.
 * It handles saving, loading, and testing Odoo credentials.
 */

const statusEl = document.getElementById('status');
const btnSave = document.getElementById('btnSave');
const btnTest = document.getElementById('btnTest');

// Map HTML IDs to variables for easy access
const inputs = {
    backendUrl: document.getElementById('backendUrl'),
    url: document.getElementById('odooBaseUrl'),
    db: document.getElementById('odooDb'),
    login: document.getElementById('odooLogin'),
    token: document.getElementById('odooApiToken')
};

/**
 * Cleans input values by removing zero-width spaces and trimming whitespace.
 * @param {string} value - The raw input value.
 * @returns {string} The sanitized value.
 */
const sanitizeInput = (value) => {
    if (value) {
        // Remove zero-width spaces (often pasted from other apps)
        return value.replace(/[\u200B\uFEFF]/g, '').trim();
    }
    return '';
}

/**
 * Updates the status message box with a given message and style.
 * @param {string} message - The text to display.
 * @param {string} type - The class (e.g., 'success', 'error', 'info', 'pending').
 */
function updateStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
}

/**
 * Checks if the `chrome.storage.local` API is available.
 * @returns {boolean} True if available, false otherwise.
 */
function isChromeStorageAvailable() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return true;
    }
    console.warn("Chrome Storage API not available. Credentials will not be persisted.");
    updateStatus("Warning: Chrome Storage API not found. Cannot save/test settings.", "error");
    return false;
}

/**
 * Saves the sanitized Odoo credentials from the form to `chrome.storage.local`.
 */
function saveOptions() {
    const backend_url = sanitizeInput(inputs.backendUrl.value).replace(/\/$/, "");
    const odoo_server = sanitizeInput(inputs.url.value).replace(/\/$/, ""); // Remove trailing slash
    const odoo_db_name = sanitizeInput(inputs.db.value);
    const username = sanitizeInput(inputs.login.value);
    const api_token = sanitizeInput(inputs.token.value);

    // Basic validation
    if (!backend_url || !odoo_server || !odoo_db_name || !username || !api_token) {
        updateStatus("Error: All fields are required.", "error");
        return;
    }
    
    if (!isChromeStorageAvailable()) return;

    // Save to local extension storage
    chrome.storage.local.set({
        backend_url,
        odoo_server, odoo_db_name, username, api_token
    }, () => {
        updateStatus('Credentials saved successfully!', 'success');
    });
}

/**
 * Loads credentials from `chrome.storage.local` and populates the form fields.
 */
function loadOptions() {
    if (!isChromeStorageAvailable()) return; 
    
    chrome.storage.local.get(['backend_url', 'odoo_server', 'odoo_db_name', 'username', 'api_token'], (result) => {
        inputs.backendUrl.value = result.backend_url || '';
        inputs.url.value = result.odoo_server || '';
        inputs.db.value = result.odoo_db_name || '';
        inputs.login.value = result.username || '';
        inputs.token.value = result.api_token || ''; 
        
        if (result.odoo_server) {
            updateStatus('Credentials loaded. Ready to test or save changes.', 'info');
        }
    });
}

/**
 * Sends the current form credentials to the backend's /test_connection endpoint.
 */
async function testConnection() {
    const backend_url = sanitizeInput(inputs.backendUrl.value).replace(/\/$/, "");
    const odoo_server = sanitizeInput(inputs.url.value).replace(/\/$/, "");
    const odoo_db_name = sanitizeInput(inputs.db.value);
    const username = sanitizeInput(inputs.login.value);
    const api_token = sanitizeInput(inputs.token.value);
    
    // Validate fields before testing
    if (!backend_url || !odoo_server || !odoo_db_name || !username || !api_token) {
        updateStatus("Error: All fields are required to test the connection.", "error");
        return;
    }

    // Disable buttons during test
    btnTest.disabled = true;
    btnSave.disabled = true;
    updateStatus("Testing connection...", "pending");

    try {
        const payload = { odoo_server, odoo_db_name, username, api_token };
        
        // Use dynamic backend_url
        const res = await fetch(`${backend_url}/test_connection`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (res.ok) {
            updateStatus(`Connection successful! ${data.message}`, "success");
        } else {
            // Display backend error message
            updateStatus(`Connection Failed: ${data.detail || "Unknown error."}`, "error");
        }
    } catch (err) {
        // Handle network errors (e.g., backend not running)
        updateStatus(`Connection Failed: Backend server (${backend_url}) not reachable.`, "error");
    } finally {
        // Re-enable buttons
        btnTest.disabled = false;
        btnSave.disabled = false;
    }
}

// --- Event Listeners ---
document.addEventListener('DOMContentLoaded', loadOptions); // Load options on page load
btnSave.addEventListener('click', saveOptions);
btnTest.addEventListener('click', testConnection);
