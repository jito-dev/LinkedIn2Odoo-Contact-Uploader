/**
 * This script powers the extension's popup.html.
 * It loads the current tab's state, requests scraped data from the content
 * script, manages campaigns, and handles the final upload to Odoo.
 */

let BACKEND_URL = ''; // Will be loaded from storage

let currentTabUrl = '';
// Global arrays to hold the state of tags and info.
// These are intentionally global to be referenced by multiple functions.
let personTags = [];
let companyTags = [];
let personInfoItems = [];
let companyInfoItems = [];
let allCampaigns = [];
let currentCampaignId = null; // This will be a string
let lastScrapedCompany = ''; // Used to track company changes for tag logic

// A list of common tags to suggest to the user
const predefinedTags = [
  "B2B", "B2C", "B2G", "SaaS", "PaaS", "D2C", "FinTech", "eCommerce", "Start-up / Startup", "SMB", "Enterprise",
  "VIP", "C-Suite", "Executive", "Manager / MGMT", "SR", "PM", "TBD", "MVP", "Key Account", "Premium",
  "Consulting", "Strategy", "Training / L&D", "Coaching", "Marketing / MKTG", "Sales", "HR", "Finance / FNCE", "Legal", "IT", "DevOps", "R&D", "Compliance", "Analytics", "SEO", "CRM"
];

/**
 * Saves the current state of the popup form (fields, tags, info)
 * to `chrome.storage.session`, keyed by the profile's URL.
 * Session storage is used to cache data until the browser is closed.
 */
function saveState() {
    if (!currentTabUrl) return;

    // We only save to session storage if we are on a valid profile page
    if (!currentTabUrl.includes("linkedin.com/in/")) {
        // If not on a profile page, clear the session storage for that URL
        // to avoid showing old data if user navigates back.
        chrome.storage.session.remove(currentTabUrl);
        return;
    }

    const dataToSave = {};
    // Save all form field values
    const fields = ["name", "company", "job_position", "email", "phone", "website", "city", "photo", "company_photo", "company_linkedin_url"];
    fields.forEach(id => {
        const el = document.getElementById(id);
        if (el) dataToSave[id] = el.value || '';
    });
    // Save tag and info arrays
    dataToSave.personTags = personTags;
    dataToSave.companyTags = companyTags;
    dataToSave.personInfoItems = personInfoItems;
    dataToSave.companyInfoItems = companyInfoItems;

    // Use chrome.storage.session to cache data for the session
    chrome.storage.session.set({ [currentTabUrl]: dataToSave });
}

/**
 * Loads the saved state for the current URL from `chrome.storage.session`
 * and then triggers a new scrape to update the data.
 * @param {object} tab - The active Chrome tab object.
 */
function loadStateAndScrape(tab) {
    // Use chrome.storage.session to get cached data
    chrome.storage.session.get([currentTabUrl], (result) => {
        const savedData = result[currentTabUrl];
        if (savedData) {
            // Restore form field values
            const fields = ["name", "company", "job_position", "email", "phone", "website", "city", "photo", "company_photo", "company_linkedin_url"];
            fields.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = savedData[id] || '';
            });

            // Restore tag and info arrays by modifying them in-place
            // This preserves the original array references.
            personTags.length = 0;
            if(savedData.personTags) personTags.push(...savedData.personTags);
            
            companyTags.length = 0;
            if(savedData.companyTags) companyTags.push(...savedData.companyTags);

            personInfoItems.length = 0;
            if(savedData.personInfoItems) personInfoItems.push(...savedData.personInfoItems);

            companyInfoItems.length = 0;
            if(savedData.companyInfoItems) companyInfoItems.push(...savedData.companyInfoItems);
            
            lastScrapedCompany = savedData.company || '';
        } else {
            // No saved session data, clear arrays just in case
            personTags.length = 0;
            companyTags.length = 0;
            personInfoItems.length = 0;
            companyInfoItems.length = 0;
        }
        
        // After loading, trigger a fresh scrape to get updates
        // only if we are on a valid profile page
        if (tab.url.includes("linkedin.com/in/")) {
            startScraping(tab);
        } else {
            // Not on a profile page, show appropriate message
            updateResult("Navigate to a LinkedIn Profile.", "info");
            document.getElementById('upload').disabled = true; // Disable upload button
        }
    });
}

/**
 * Renders an array of strings as "pills" (tags) in a container.
 * @param {string} containerId - The ID of the container to render pills in.
 * @param {string[]} items - The array of tag strings.
 * @param {function} onRemove - The callback function to execute when a pill's 'x' is clicked.
 */
function renderPills(containerId, items, onRemove) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    items.forEach((item, index) => {
        const pill = document.createElement('div');
        pill.className = 'tag-pill';
        pill.textContent = item;
        const removeBtn = document.createElement('span');
        removeBtn.className = 'tag-remove';
        removeBtn.textContent = 'x';
        removeBtn.onclick = () => onRemove(index);
        pill.appendChild(removeBtn);
        container.appendChild(pill);
    });
}

/**
 * Renders all four pill containers (person/company tags, person/company info).
 */
function renderAllPills() {
    renderPills('tags-container', personTags, (i) => { personTags.splice(i, 1); renderAllPills(); saveState(); });
    renderPills('company-tags-container', companyTags, (i) => { companyTags.splice(i, 1); renderAllPills(); saveState(); });
    renderPills('info-container', personInfoItems, (i) => { personInfoItems.splice(i, 1); renderAllPills(); saveState(); });
    renderPills('company-info-container', companyInfoItems, (i) => { companyInfoItems.splice(i, 1); renderAllPills(); saveState(); });
}

/**
 * Updates the profile photo preview element based on the 'photo' input field.
 */
function updatePhotoPreview() {
    const photoUrl = document.getElementById('photo').value;
    const previewEl = document.getElementById('photo-preview');
    if (photoUrl) {
        previewEl.src = photoUrl;
        previewEl.style.display = 'block';
    } else {
        previewEl.style.display = 'none';
    }
}

// Initial setup when the popup DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0] || !tabs[0].url) return;
        currentTabUrl = tabs[0].url.split('?')[0]; // Use base URL as the key

        // 1. Load Odoo credentials (from .local storage)
        loadCredentials(() => {
            // 2. Check if credentials are valid
            if (checkCredentials()) {
                // 3. Load campaign data from backend and active campaign from .local storage
                loadCampaignsAndApply(tabs[0]);
            }
        });

        // Setup event listeners
        document.getElementById('currentCampaign').addEventListener('change', handleCampaignChange);
        document.getElementById("upload").addEventListener("click", handleUpload);
        
        // Setup all pill/tag inputs
        setupPillInput('tags-input', personTags, 'tags-container', 'tags-dropdown');
        setupPillInput('company-tags-input', companyTags, 'company-tags-container', 'company-tags-dropdown');
        setupInfoInput('info-input', personInfoItems, 'info-container');
        setupInfoInput('company-info-input', companyInfoItems, 'company-info-container');
        
        // Save state on any form input change
        const fieldsToSave = ["name", "company", "job_position", "email", "phone", "website", "city", "photo", "company_photo", "company_linkedin_url"];
        fieldsToSave.forEach(id => {
            document.getElementById(id)?.addEventListener('input', saveState);
        });
    });
});

/**
 * Configures an input for adding pills, including an autocomplete dropdown.
 * @param {string} inputId - ID of the <input> element.
 * @param {string[]} itemsArray - The global array to add tags to.
 * @param {string} containerId - ID of the container to render pills in.
 * @param {string} dropdownId - ID of the autocomplete dropdown element.
 */
function setupPillInput(inputId, itemsArray, containerId, dropdownId) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);
    
    /** Adds the value to the global array */
    const onAdd = (value) => {
        const trimmedValue = value.trim();
        if (trimmedValue && !itemsArray.includes(trimmedValue)) {
            itemsArray.push(trimmedValue);
            renderAllPills();
            saveState(); // Save to session storage
        }
        input.value = '';
        if(dropdown) dropdown.classList.add('hidden');
    };
    
    // Add on 'Enter'
    input.addEventListener('keydown', (e) => { 
        if (e.key === 'Enter') { 
            e.preventDefault(); 
            onAdd(input.value); 
        } 
    });

    // Handle autocomplete dropdown logic
    if (dropdown) {
        input.addEventListener('input', () => {
            const filter = input.value.toLowerCase();
            if (!filter) { dropdown.classList.add('hidden'); return; }
            dropdown.innerHTML = '';
            const filtered = predefinedTags.filter(t => t.toLowerCase().includes(filter));
            filtered.forEach(tag => {
                const item = document.createElement('div');
                item.className = 'dropdown-item';
                item.textContent = tag;
                item.onclick = () => onAdd(tag);
                dropdown.appendChild(item);
            });
            dropdown.classList.toggle('hidden', filtered.length === 0);
        });
        // Hide on click outside
        document.addEventListener('click', (e) => { if (!input.contains(e.target)) dropdown.classList.add('hidden'); });
    }
}

/**
 * Configures a simple input for adding info pills (no dropdown).
 * @param {string} inputId - ID of the <input> element.
 * @param {string[]} itemsArray - The global array to add info to.
 * @param {string} containerId - ID of the container to render pills in.
 */
function setupInfoInput(inputId, itemsArray, containerId) {
    const input = document.getElementById(inputId);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const value = input.value.trim();
            if (value && !itemsArray.includes(value)) {
                itemsArray.push(value);
                renderAllPills();
                saveState(); // Save to session storage
            }
            input.value = '';
        }
    });
}

/**
 * Fetches all campaigns from backend and current campaign ID from storage.
 * Populates dropdown and then loads saved state/scrapes.
 * @param {object} tab - The active Chrome tab object.
 */
async function loadCampaignsAndApply(tab) {
    try {
        // Get backend_url from hidden field
        BACKEND_URL = document.getElementById('backend_url').value;
        if (!BACKEND_URL) {
            throw new Error("Backend URL not set in options.");
        }

        const campaignsRes = await fetch(`${BACKEND_URL}/campaigns`);
        if (!campaignsRes.ok) throw new Error('Failed to fetch campaigns');
        allCampaigns = await campaignsRes.json();
        
        // Get current campaign ID from local storage
        chrome.storage.local.get('currentCampaignId', (result) => {
            currentCampaignId = result.currentCampaignId || null; // Will be string or null
            
            // Populate the dropdown
            const select = document.getElementById('currentCampaign');
            select.innerHTML = '<option value="">None</option>';
            allCampaigns.forEach(c => {
                const option = document.createElement('option');
                option.value = c.id; // c.id is a string from uuid
                option.textContent = c.name;
                select.appendChild(option);
            });
            
            // Set the active campaign in the dropdown
            if (currentCampaignId) {
                select.value = currentCampaignId;
            }
            
            // Now that campaigns are loaded, load session state and scrape
            loadStateAndScrape(tab);
        });

    } catch (error) { 
        console.error("Failed to load campaigns:", error);
        updateResult("Failed to load campaigns.", "error");
        // Still try to load state/scrape even if campaigns fail
        loadStateAndScrape(tab);
    }
}

/**
 * Handles logic for when the user changes the active campaign in the dropdown.
 * Removes tags from old campaign, adds tags from new one, and saves setting.
 * @param {Event} event - The 'change' event object.
 */
async function handleCampaignChange(event) {
    const newCampaignId = event.target.value; // This is a string (or "" for "None")
    
    // Find old campaign
    const oldCampaign = allCampaigns.find(c => c.id == currentCampaignId);
    
    // Remove tags from the old campaign (if one was selected)
    if (oldCampaign) {
        const personTagsToRemove = new Set(oldCampaign.person_tags || []);
        const companyTagsToRemove = new Set(oldCampaign.company_tags || []);
        
        // Add the campaign name itself to the removal sets
        if (oldCampaign.name) {
            personTagsToRemove.add(oldCampaign.name);
            companyTagsToRemove.add(oldCampaign.name);
        }

        // Modify arrays in-place to preserve references
        for (let i = personTags.length - 1; i >= 0; i--) {
            if (personTagsToRemove.has(personTags[i])) {
                personTags.splice(i, 1);
            }
        }
        for (let i = companyTags.length - 1; i >= 0; i--) {
            if (companyTagsToRemove.has(companyTags[i])) {
                companyTags.splice(i, 1);
            }
        }
    }
    
    // Save new campaign ID to local storage
    currentCampaignId = newCampaignId ? String(newCampaignId) : null;
    chrome.storage.local.set({ currentCampaignId: currentCampaignId });
    
    applyCampaignTags(currentCampaignId, true); // Add tags from the new campaign
}

/**
 * Adds tags from the specified campaign to the global tag arrays.
 * Also adds the campaign name as a tag.
 * @param {string} campaignId - The ID of the campaign to apply.
 * @param {boolean} forceApplyCompany - Whether to apply company tags (e.g., on change)
 */
function applyCampaignTags(campaignId, forceApplyCompany = false) {
    const campaign = allCampaigns.find(c => c.id == campaignId);
    if (campaign) {
        // Add person tags (if not already present)
        (campaign.person_tags || []).forEach(tag => { if (!personTags.includes(tag)) personTags.push(tag); });
        
        // Add the campaign's name as a tag to person
        if (campaign.name && !personTags.includes(campaign.name)) {
            personTags.push(campaign.name);
        }

        // Add company tags (if not already present)
        if (forceApplyCompany) {
            (campaign.company_tags || []).forEach(tag => { if (!companyTags.includes(tag)) companyTags.push(tag); });
            
            // Add the campaign's name as a tag to company
            if (campaign.name && !companyTags.includes(campaign.name)) {
                companyTags.push(campaign.name);
            }
        }
    }
    renderAllPills();
    saveState(); // Save to session storage
}

/**
 * Sends a message to the content script to request scraped data.
 * @param {object} tab - The active Chrome tab object.
 */
function startScraping(tab) {
    if (!tab.url.includes("linkedin.com/in/")) {
        return updateResult("Navigate to a LinkedIn Profile page.", "error");
    }

    updateResult("Scraping profile...", "pending");
    chrome.tabs.sendMessage(tab.id, { action: "scrape" }, (response) => {
        if (chrome.runtime.lastError) {
            return updateResult(`Error scraping. Refresh page & try again.`, "error");
        }
        // Check if content script sent back an error (e.g., from scraping)
        if (response && response.error) {
             return updateResult(`Error: ${response.error}`, "error");
        }
        if (!response) {
            return updateResult("No data scraped. Try refreshing.", "info");
        }

        // Logic to handle changing profiles/companies
        const newCompany = response.company;
        if (newCompany && newCompany !== lastScrapedCompany) {
            // If company has changed, remove old campaign's company tags
            const oldCampaign = allCampaigns.find(c => c.id == currentCampaignId);
            if (oldCampaign) {
                // Modify array in-place
                const companyTagsToRemove = new Set(oldCampaign.company_tags || []);
                // Also remove campaign name tag
                if(oldCampaign.name) companyTagsToRemove.add(oldCampaign.name);

                for (let i = companyTags.length - 1; i >= 0; i--) {
                    if (companyTagsToRemove.has(companyTags[i])) {
                        companyTags.splice(i, 1);
                    }
                }
            }
        }
        lastScrapedCompany = newCompany || '';

        // Populate form fields *only if they are empty* (to respect session cache)
        const fields = ["name", "company", "job_position", "email", "phone", "website", "city", "photo", "company_photo", "company_linkedin_url"];
        fields.forEach(key => {
            const el = document.getElementById(key);
            if (el && !el.value && response[key]) {
                el.value = response[key];
            }
        });
        
        // Special case: always update URL
        if(response.url) document.getElementById('website').value = response.url;


        // Add scraped "additional info" items if they aren't duplicates
        const scrapedInfo = response.additional_info ? response.additional_info.split('\n').filter(Boolean) : [];
        const existingInfoSet = new Set(personInfoItems);
        scrapedInfo.forEach(item => { 
            if (!existingInfoSet.has(item)) {
                personInfoItems.push(item);
            }
        });
        
        // Re-apply campaign tags
        applyCampaignTags(currentCampaignId, true);
        updatePhotoPreview();
        saveState(); // Save to session storage
        updateResult("Profile data updated.", "info");
    });
}

/**
 * Checks if the form data is essentially empty (ignoring tags/info).
 * @param {object} payload - The data payload to be sent.
 * @returns {boolean} True if all key fields are empty, false otherwise.
 */
function isPayloadDataEmpty(payload) {
    if (!payload) return true;
    // Check all key fields. If any has a value, it's not empty.
    const keyFields = [
        'name', 'company', 'job_position', 'email', 'phone', 
        'website', 'city',
        'photo', 'company_photo', 'company_linkedin_url'
    ];
    for (const field of keyFields) {
        if (payload[field]) {
            return false; // Found data
        }
    }
    return true; // All key fields were empty
}

/**
 * Gathers all data from the form and sends it to the backend /create_contact endpoint.
 */
async function handleUpload() {
    if (!checkCredentials()) return;
    
    // Build the payload from form fields
    const payload = {};
    const fields = ["name", "company", "job_position", "email", "phone", "website", "city", "photo", "company_photo", "company_linkedin_url"];
    fields.forEach(id => payload[id] = document.getElementById(id)?.value.trim() || null);
    
    // Prevent creating an empty contact
    if (isPayloadDataEmpty(payload)) {
        updateResult("❌ Error: Cannot create an empty contact.", "error");
        return; // Stop execution
    }

    // Add tags and info, ensuring uniqueness and correct format
    payload.tags = [...new Set(personTags)].join(',');
    payload.company_tags = [...new Set(companyTags)].join(',');
    payload.additional_info = personInfoItems.join('\n');
    payload.company_additional_info = companyInfoItems.join('\n');
    
    // Add Odoo credentials from hidden fields
    Object.assign(payload, { 
        odoo_server: document.getElementById('odoo_server').value, 
        odoo_db_name: document.getElementById('odoo_db_name').value, 
        username: document.getElementById('username').value, 
        api_token: document.getElementById('access_token').value, 
    });
    payload.contact_type = "individual";
    
    updateResult("Sending...", "pending");
    try {
        // Get backend_url from hidden field
        BACKEND_URL = document.getElementById('backend_url').value;
        if (!BACKEND_URL) throw new Error("Backend URL not set.");

        const res = await fetch(`${BACKEND_URL}/create_contact`, { 
            method: "POST", 
            headers: { "Content-Type": "application/json" }, 
            body: JSON.stringify(payload) 
        });
        const data = await res.json();
        if (res.ok) {
            updateResult(`Success! Person: ${data.person_id}, Co: ${data.company_id || 'N/A'}`, "success");
            // Clear session cache for this URL after successful upload
            chrome.storage.session.remove(currentTabUrl);
        } else if (res.status === 422) {
            // Handle validation errors from FastAPI
            updateResult(`Error 422: ${data.detail ? (data.detail[0].msg + " in " + data.detail[0].loc.join(' -> ')) : "No detail."}`, "error");
        } else {
            updateResult(`Error (${res.status}): ${data.detail || "Unknown error"}`, "error");
        }
    } catch (err) { 
        console.error("Upload error:", err);
        updateResult(`Error: Backend not reachable.`, "error");
    }
}

/**
 * Loads Odoo credentials from storage and populates hidden fields in the popup.
 * @param {function} callback - Function to execute after credentials are loaded.
 */
function loadCredentials(callback) {
    // Credentials always come from .local storage
    chrome.storage.local.get(['odoo_server', 'odoo_db_name', 'username', 'api_token', 'backend_url'], (result) => {
        document.getElementById('odoo_server').value = result.odoo_server || '';
        document.getElementById('odoo_db_name').value = result.odoo_db_name || '';
        document.getElementById('username').value = result.username || '';
        document.getElementById('access_token').value = result.api_token || '';
        document.getElementById('backend_url').value = result.backend_url || '';
        if (callback) callback();
    });
}

/**
 * Checks if all required Odoo credentials are present in the hidden fields.
 * Disables the "Upload" button if credentials are missing.
 * @returns {boolean} True if all credentials exist, false otherwise.
 */
function checkCredentials() {
    const creds = ['odoo_server', 'odoo_db_name', 'username', 'access_token', 'backend_url'];
    const isReady = creds.every(id => document.getElementById(id).value);
    
    // Also disable if not on a profile page
    const onProfilePage = currentTabUrl.includes("linkedin.com/in/");
    
    document.getElementById('upload').disabled = !isReady || !onProfilePage;

    if(!isReady) updateResult("Missing credentials or Backend URL in settings.", "error");
    else if(!onProfilePage) updateResult("Navigate to a LinkedIn Profile.", "info");

    return isReady;
}

/**
 * Updates the status message bar at the bottom of the popup.
 * @param {string} message - The text to display.
 * @param {string} type - The class (e.g., 'success', 'error', 'info', 'pending').
 */
let toastTimer = null; // Timer to hide toast

function updateResult(message, type) {
    const resultDiv = document.getElementById("result");
    resultDiv.textContent = message;
    resultDiv.className = type + ' show'; // Add .show

    // Clear existing timer if any
    if (toastTimer) {
        clearTimeout(toastTimer);
    }

    // Set timer to hide toast after 4 seconds
    // Only auto-hide if not a 'pending' message
    if (type !== 'pending') {
        toastTimer = setTimeout(() => {
            resultDiv.classList.remove('show');
        }, 4000);
    }
}

