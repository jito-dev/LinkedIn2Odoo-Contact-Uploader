/**
 * Content script injected into LinkedIn profile pages.
 * Responsible for:
 * 1. Scraping profile data from the DOM.
 * 2. Injecting a floating "Create/Update Contact" button.
 * 3. Checking if the contact already exists in Odoo.
 * 4. Handling the button click to send data to the backend.
 * 5. Receiving messages from the popup (scrape request) and background (navigation).
 */

let BACKEND_URL = ''; // Will be loaded from storage
let odooCredentials = {
    backend_url: '',
    odoo_server: '',
    odoo_db_name: '',
    username: '',
    api_token: ''
};
let contactExists = false;
let contactId = null;
let toastTimer = null; // Timer reference for hiding the toast

/**
 * Scrapes the visible LinkedIn profile DOM for contact information.
 * This function is complex due to LinkedIn's changing class names
 * and layouts (e.g., single vs. multi-role experience items).
 * @returns {object} An object containing scraped profile data.
 */
function scrapeLinkedInProfile() {
    // This function attempts to find data from multiple known DOM structures
    const data = {
        url: window.location.href.split('?')[0], // Use base URL
        name: '', job_position: '', photo: '', company: '', 
        city: '',
        website: '', email: '', phone: '', additional_info: '', 
        company_photo: '', company_linkedin_url: '',
    };

    try {
        // Main profile card
        const mainProfileSection = document.querySelector("section.artdeco-card");
        if (mainProfileSection) {
            data.name = mainProfileSection.querySelector("h1")?.innerText?.trim() || "";
            // Try multiple selectors for the profile photo (including self-profile edit button)
            data.photo = document.querySelector("img.profile-displayphoto-image")?.src || 
                         document.querySelector("img.pv-top-card-profile-picture__image--show")?.src || 
                         document.querySelector("div.pv-top-card--photo img[src*='dms/image']")?.src ||
                         document.querySelector("img.profile-photo-edit__preview")?.src || "";
            
            // Selector for person's location (e.g., "Sydney, New South Wales, Australia")
            data.city = mainProfileSection.querySelector("span.text-body-small.inline.t-black--light.break-words")?.innerText?.trim() || "";
        }

        // "About" section
        const aboutSection = document.querySelector('#about .inline-show-more-text');
        if (aboutSection) {
            data.additional_info = aboutSection.innerText.trim();
        }
      
        // "Experience" section
        const experienceSection = document.getElementById('experience')?.parentElement;
        if (experienceSection) {
            const firstExperienceItem = experienceSection.querySelector(':scope > div > ul > li');
            if (firstExperienceItem) {
                data.company_photo = firstExperienceItem.querySelector('a[data-field="experience_company_logo"] img')?.src || '';
                data.company_linkedin_url = firstExperienceItem.querySelector('a[data-field="experience_company_logo"]')?.href || '';

                // Check if this is a multi-role item
                // We check if the sub-components list contains another experience entity
                const multiRoleList = firstExperienceItem.querySelector('.pvs-entity__sub-components ul li div[data-view-name="profile-component-entity"]');

                if (multiRoleList) {
                    // --- Multi-role (e.g., "Valtech") ---
                    // Company is at the top
                    data.company = firstExperienceItem.querySelector(':scope > div > div:nth-child(2) > div > a .hoverable-link-text.t-bold span[aria-hidden="true"]')?.innerText.trim() || '';
                    // Job position is the *first* item in the sub-list
                    data.job_position = firstExperienceItem.querySelector('.pvs-entity__sub-components ul li .hoverable-link-text.t-bold span[aria-hidden="true"]')?.innerText.trim() || '';
                } else {
                    // --- Single-role (self, connected, following) ---
                    // Job position
                    const jobTitleEl = firstExperienceItem.querySelector('.display-flex.align-items-center.mr1.hoverable-link-text.t-bold span[aria-hidden="true"]');
                    data.job_position = jobTitleEl ? jobTitleEl.innerText.trim() : '';
                    
                    // Company name
                    const companyEl = firstExperienceItem.querySelector('span.t-14.t-normal > span[aria-hidden="true"]');
                    data.company = companyEl ? companyEl.innerText.split('·')[0].trim() : '';
                }
            }
        }

        // Contact info modal (this is scraped *after* the modal is opened)
        const contactInfoModal = document.querySelector('.artdeco-modal__content');
        let extraContactInfo = [], websiteList = [];
        if (contactInfoModal) {
            contactInfoModal.querySelectorAll('section.pv-contact-info__contact-type').forEach(section => {
                const header = section.querySelector('h3.pv-contact-info__header')?.innerText.trim().toLowerCase();
                if (!header || header.includes('connected')) return;

                if (header.includes('profile')) data.website = section.querySelector('a')?.href || '';
                else if (header.includes('email')) data.email = section.querySelector('a')?.href.replace('mailto:', '') || '';
                else if (header.includes('phone')) data.phone = section.querySelector('.t-14 span')?.innerText.trim() || '';
                else if (header.includes('websites')) section.querySelectorAll('li a').forEach(l => websiteList.push(`${l.href} ${l.nextElementSibling?.innerText.trim()||''}`));
                else {
                    // Capture any other fields
                    const val = section.querySelector('.t-14 span, .t-14 a')?.innerText.trim();
                    if (val) extraContactInfo.push(`${section.querySelector('h3').innerText.trim()}: ${val}`);
                }
            });
        }

        // Combine "About" text with contact info details
        let finalAdditionalInfo = data.additional_info ? data.additional_info + '\n\n' : '';
        if (websiteList.length > 0) finalAdditionalInfo += 'Websites:\n' + websiteList.join('\n') + '\n';
        finalAdditionalInfo += extraContactInfo.join('\n');
        data.additional_info = finalAdditionalInfo.trim();

        // Clean up fields
        data.name = data.name.split('\n')[0].trim(); // Handle names with extra text
    
    } catch (e) {
        console.error("LinkedIn Scraper Error:", e);
        // This will be caught by the caller and shown in the toast
        throw new Error(`Scraping failed: ${e.message}`);
    }
    
    return data;
}

/**
 * Orchestrates the scraping process by:
 * 1. Scraping the main page.
 * 2. Clicking the "Contact info" link.
 * 3. Waiting for the modal to open.
 * 4. Scraping the modal content.
 * 5. Closing the modal.
 * @returns {object} Combined data from the main page and contact modal.
 */
async function scrapeProfileAndContactInfo() {
    let data = {};
    try {
        data = scrapeLinkedInProfile(); // 1. Scrape main page
        
        // 2. Find and click "Contact info" link
        const contactInfoLink = Array.from(document.querySelectorAll('a')).find(a => a.id && a.id.includes('contact-info'));
        if (contactInfoLink) {
            contactInfoLink.click();
            await new Promise(resolve => setTimeout(resolve, 1500)); // 3. Wait for modal
            
            // 4. Scrape modal and merge data
            const contactData = scrapeLinkedInProfile();
            
            // Merge, prioritizing modal data for these fields
            data.website = contactData.website || data.website;
            data.email = contactData.email || data.email;
            data.phone = contactData.phone || data.phone;
            // Merge additional info - ensure no duplication if scraped twice
            let combinedInfo = data.additional_info || '';
            if (contactData.additional_info && combinedInfo !== contactData.additional_info) {
                 combinedInfo += '\n\n' + contactData.additional_info;
            }
            data.additional_info = combinedInfo.trim();
            
            document.querySelector('.artdeco-modal__dismiss')?.click(); // 5. Close modal
        }
    } catch (e) {
        console.error("Scrape Orchestration Error:", e);
        // Try to close modal if it's open, then re-throw
        document.querySelector('.artdeco-modal__dismiss')?.click();
        throw e; // Re-throw to be caught by callers
    }
    return data;
}

/**
 * Injects the floating button and toast notification elements into the DOM.
 */
function injectUI() {
    if (document.getElementById('odoo-floating-button')) return; // Already injected

    // Inject floating button
    const button = document.createElement('button');
    button.id = 'odoo-floating-button';
    // Default to "Choose person" state
    button.innerHTML = `<span>Choose person</span> <img src="${chrome.runtime.getURL('logo.svg')}" />`; 
    button.disabled = true; // Disabled by default
    document.body.appendChild(button);

    // Inject toast container
    const toast = document.createElement('div');
    toast.id = 'odoo-toast';
    document.body.appendChild(toast);
    
    // Inject styles for the UI elements
    const style = document.createElement('style');
    style.innerHTML = `
        #odoo-floating-button {
            position: fixed; left: 20px; bottom: 20px; z-index: 9999;
            background-color: white; border: 1px solid black; border-radius: 25px;
            padding: 10px 20px; cursor: pointer; display: flex; align-items: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            font-weight: 600; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            transition: all 0.2s ease-in-out;
        }
        #odoo-floating-button:hover:not(:disabled) { 
            transform: translateY(-2px); 
            box-shadow: 0 6px 16px rgba(0,0,0,0.2); 
        }
        #odoo-floating-button:disabled {
            cursor: not-allowed;
            opacity: 0.7;
        }
        #odoo-floating-button img { width: 24px; height: 24px; margin-left: 12px; }
        #odoo-toast {
            position: fixed; bottom: 20px; right: -400px; /* Start hidden */
            background-color: #28a745;
            color: white; padding: 16px 24px; border-radius: 8px; z-index: 10000;
            font-family: sans-serif; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            transition: right 0.5s ease-in-out;
            max-width: 300px; /* Constrain width */
            word-wrap: break-word; /* Wrap long text */
        }
        #odoo-toast.show { right: 20px; /* Slide in */ }
    `;
    document.head.appendChild(style);

    button.addEventListener('click', handleFloatingButtonClick);
}

/**
 * Displays a toast notification with a message.
 * @param {string} message - The text to display.
 * @param {boolean} [isError=false] - Optional. True to show an error style.
 */
function showToast(message, isError = false) {
    const toast = document.getElementById('odoo-toast');
    if (!toast) return; // Guard against missing element

    // Clear previous timer if exists
    if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
    }

    toast.textContent = message;
    toast.style.backgroundColor = isError ? '#dc3545' : '#28a745'; // Red for error, green for success
    toast.classList.add('show');
    
    // Set timer to hide toast after 4 seconds
    toastTimer = setTimeout(() => {
        toast.classList.remove('show');
        toastTimer = null;
    }, 4000);
}


/**
 * Updates the floating button's text and state.
 */
function updateButtonState() {
    const button = document.getElementById('odoo-floating-button');
    if (!button) return;

    if (location.href.includes("linkedin.com/in/")) {
        // We are on a profile page
        if (contactExists) {
            button.querySelector('span').textContent = '🔁 Update Contact';
        } else {
            button.querySelector('span').textContent = '➕ Create Contact';
        }
        button.disabled = false;
    } else {
        // We are not on a profile page, but on linkedin.com
        button.querySelector('span').textContent = 'Choose person';
        button.disabled = true;
    }
}

/**
 * Checks the backend to see if the current profile exists in Odoo.
 */
async function checkContactStatus() {
    const button = document.getElementById('odoo-floating-button');
    if (!button) return; // UI not ready

    // Do not run if credentials aren't set
    if (!odooCredentials.api_token || !odooCredentials.backend_url) {
        button.querySelector('span').textContent = 'Setup Credentials';
        button.disabled = true;
        return;
    }

    // Only run the *check* if we are on a profile page
    if (!location.href.includes("linkedin.com/in/")) {
        updateButtonState();
        return;
    }

    const name = document.querySelector('h1')?.innerText?.trim().split('\n')[0].trim();
    if (!name) {
        updateButtonState(); // No name found, keep button disabled
        return;
    }
    
    button.style.display = 'flex'; // Ensure visible

    try {
        const res = await fetch(`${odooCredentials.backend_url}/check_contact`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...odooCredentials, name })
        });
        if (!res.ok) { 
            contactExists = false; 
            // Attempt to get error detail
            try {
                const errorData = await res.json();
                console.error("Check Contact Error Response:", errorData.detail || `Status ${res.status}`);
            } catch {
                console.error("Check Contact Error: Status", res.status);
            }
        } else {
            const data = await res.json();
            contactExists = data.exists;
            contactId = data.id;
        }
    } catch (e) {
        console.error("Could not check contact status (Fetch Error):", e);
        contactExists = false; 
    } finally {
        updateButtonState();
    }
}

/**
 * Checks if the scraped data object is essentially empty (ignoring URL).
 * @param {object} data - The scraped profile data.
 * @returns {boolean} True if all key fields are empty, false otherwise.
 */
function isProfileDataEmpty(data) {
    if (!data) return true;
    // Check all key fields. If any has a value, it's not empty.
    const keyFields = [
        'name', 'job_position', 'company', 
        'city',
        'website', 'email', 'phone', 'additional_info'
    ];
    for (const field of keyFields) {
        if (data[field]) {
            return false; // Found data
        }
    }
    return true; // All key fields were empty
}


/**
 * Handles the click event for the floating button.
 * It scrapes data, fetches current campaign tags, and sends data to the backend.
 */
async function handleFloatingButtonClick() {
    const button = document.getElementById('odoo-floating-button');
    const originalText = button.querySelector('span').textContent;
    button.querySelector('span').textContent = 'Processing...';
    button.disabled = true;

    try {
        // 1. Scrape all profile data
        const profileData = await scrapeProfileAndContactInfo();
        
        // Prevent creating an empty contact
        if (isProfileDataEmpty(profileData)) {
            // Show toast and reload the page
            showToast("❌ Error: Empty contact. Please reload page.", true);
            // Wait for toast to be visible, then reload
            setTimeout(() => {
                location.reload();
            }, 2000);
            return; // Stop execution
        }
        
        // 2. Fetch all campaigns and the current campaign ID (from storage)
        const campaignsResponse = await fetch(`${odooCredentials.backend_url}/campaigns`);
        if (!campaignsResponse.ok) throw new Error('Could not load campaigns.');
        const campaigns = await campaignsResponse.json();
        
        const storage = await chrome.storage.local.get('currentCampaignId');
        const currentCampaignId = storage.currentCampaignId;

        let campaignTags = { person_tags: [], company_tags: [] };
        if (currentCampaignId && campaigns) {
            const currentCampaign = campaigns.find(c => c.id == currentCampaignId);
            if (currentCampaign) {
                campaignTags.person_tags = currentCampaign.person_tags || [];
                campaignTags.company_tags = currentCampaign.company_tags || [];
                // Add campaign name as tag
                if (currentCampaign.name) {
                    campaignTags.person_tags.push(currentCampaign.name);
                    campaignTags.company_tags.push(currentCampaign.name);
                }
            }
        }

        // 3. Construct the final payload
        const payload = {
            ...profileData,
            ...odooCredentials,
            contact_type: "individual",
            // Send unique tags
            tags: [...new Set(campaignTags.person_tags)].join(','),
            company_tags: [...new Set(campaignTags.company_tags)].join(',')
        };

        // 4. Send data to the backend to create/update the contact
        const res = await fetch(`${odooCredentials.backend_url}/create_contact`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        // Check for fetch error (res.ok will be false)
        if (!res.ok) {
            let errorDetail = `Request failed (${res.status})`;
            try {
                const errorData = await res.json();
                errorDetail = errorData.detail || errorDetail;
            } catch (jsonError) {
                // Ignore if response isn't JSON
            }
            throw new Error(errorDetail);
        }

        const data = await res.json();
        // Check for logical error (e.g., validation) even if status is 200
        if (data.detail) {
             throw new Error(data.detail);
        }

        // 5. Show success toast and update button state
        const stateText = contactExists ? 'Updated' : 'Created';
        showToast(`✅ ${stateText}: ${payload.name}`);
        
        contactExists = true; // Assume success means it now exists (or was updated)
        contactId = data.person_id;

    } catch (e) {
        console.error("Error handling button click:", e);
        let errorMsg = e.message;
        if (errorMsg.includes("Odoo Error:")) {
            errorMsg = "Odoo Error"; 
        } else if (errorMsg.includes("Failed to fetch") || errorMsg.includes("NetworkError")) {
            errorMsg = "Connection Error";
        } else if (errorMsg.includes("Request failed")) {
             errorMsg = "Backend Error"; // General backend issue
        } else if (errorMsg.includes("Scraping failed")) {
             errorMsg = "Scraping Error";
        }
        showToast(`❌ Error: ${errorMsg}`, true); 
    } finally {
        updateButtonState(); // Revert button text/state
        // Re-enable button only if on a profile page
        button.disabled = !location.href.includes("linkedin.com/in/"); 
    }
}

/**
 * Initializes the content script.
 * Loads credentials, injects UI, and checks contact status.
 */
function init() {
    // Always inject UI if on linkedin.com
    if (location.href.includes("linkedin.com/")) {
        injectUI();
    } else {
        return; // Not on linkedin, do nothing
    }
    
    // Load credentials from storage
    chrome.storage.local.get(['odoo_server', 'odoo_db_name', 'username', 'api_token', 'backend_url'], (result) => {
        odooCredentials = {
            odoo_server: result.odoo_server, odoo_db_name: result.odoo_db_name,
            username: result.username, api_token: result.api_token,
            backend_url: result.backend_url
        };
        
        // Wait for page to settle, then check status (which also updates button)
        setTimeout(checkContactStatus, 1500); 
    });
}

// --- Listen for messages from popup or background script ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "scrape") {
        // Popup is requesting data. Scrape and send it back.
        scrapeProfileAndContactInfo().then(sendResponse)
        .catch(err => {
            // Send the error message back to the popup
            sendResponse({ error: err.message });
        });
        return true; // Indicates an asynchronous response
    } else if (request.action === "navigate") {
        // Background script detected a URL change. Re-initialize.
        setTimeout(init, 1000); // Wait for new page content to load
    }
});

// --- Initial run ---
// Use a small delay to ensure DOM is ready
setTimeout(init, 500);

