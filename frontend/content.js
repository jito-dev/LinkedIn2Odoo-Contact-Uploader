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
    // Default website to the current LinkedIn profile URL
    // We'll try to clean it up if it has overlay garbage
    let currentUrl = window.location.href.split('?')[0];
    if (currentUrl.includes('/overlay/')) {
        currentUrl = currentUrl.split('/overlay/')[0];
    }
    
    const data = {
        url: currentUrl,
        name: '', job_position: '', photo: '', company: '', 
        city: '',
        website: currentUrl, // Default to cleaned current URL
        email: '', phone: '', additional_info: '', 
        company_photo: '', company_linkedin_url: '',
        birthday: '' 
    };

    try {
        // --- 1. Main Profile Header ---
        const mainProfileSection = document.querySelector("section.artdeco-card");
        if (mainProfileSection) {
            data.name = mainProfileSection.querySelector("h1")?.innerText?.trim() || "";
            
            // Selector for person's location
            data.city = mainProfileSection.querySelector("span.text-body-small.inline.t-black--light.break-words")?.innerText?.trim() || "";
        }

        // --- Photo Extraction ---
        const ariaPhoto = document.querySelector('div[aria-label="Profile photo"] img');
        if (ariaPhoto) {
            data.photo = ariaPhoto.src;
        }

        // --- Fallback: New Top Card Structure (based on data-view-name) ---
        if (!data.name) {
            const newNameEl = document.querySelector("div[data-view-name='profile-top-card-verified-badge'] p") || 
                              document.querySelector("div[data-view-name='profile-top-card'] h1");
            if (newNameEl) data.name = newNameEl.innerText.trim();
        }

        if (!data.city) {
            // Strategy: Find the "Contact info" link
            const contactLink = Array.from(document.querySelectorAll('a')).find(el => el.innerText.includes('Contact info'));
            if (contactLink) {
                // Navigate up to the container
                const container = contactLink.closest('div');
                if (container) {
                    const pTags = container.querySelectorAll('p');
                    if (pTags.length > 0) {
                        data.city = pTags[0].innerText.trim();
                    }
                }
            }
        }

        // --- 2. About Section ---
        const aboutSection = document.querySelector('#about .inline-show-more-text');
        if (aboutSection) {
            data.additional_info = aboutSection.innerText.trim();
        }
      
        // --- 3. Experience Section ---
        let experienceFound = false;

        // A. Try Old Selector
        const experienceSection = document.getElementById('experience')?.parentElement;
        if (experienceSection) {
            const firstExperienceItem = experienceSection.querySelector(':scope > div > ul > li');
            if (firstExperienceItem) {
                experienceFound = true;
                data.company_photo = firstExperienceItem.querySelector('a[data-field="experience_company_logo"] img')?.src || '';
                data.company_linkedin_url = firstExperienceItem.querySelector('a[data-field="experience_company_logo"]')?.href || '';

                // Check if this is a multi-role item
                const multiRoleList = firstExperienceItem.querySelector('.pvs-entity__sub-components ul li div[data-view-name="profile-component-entity"]');

                if (multiRoleList) {
                    // Multi-role (Old Layout)
                    data.company = firstExperienceItem.querySelector(':scope > div > div:nth-child(2) > div > a .hoverable-link-text.t-bold span[aria-hidden="true"]')?.innerText.trim() || '';
                    data.job_position = firstExperienceItem.querySelector('.pvs-entity__sub-components ul li .hoverable-link-text.t-bold span[aria-hidden="true"]')?.innerText.trim() || '';
                } else {
                    // Single-role (Old Layout)
                    const jobTitleEl = firstExperienceItem.querySelector('.display-flex.align-items-center.mr1.hoverable-link-text.t-bold span[aria-hidden="true"]');
                    data.job_position = jobTitleEl ? jobTitleEl.innerText.trim() : '';
                    
                    const companyEl = firstExperienceItem.querySelector('span.t-14.t-normal > span[aria-hidden="true"]');
                    data.company = companyEl ? companyEl.innerText.split('·')[0].trim() : '';
                }
            }
        }

        // B. Try New Selector (if old one failed or returned nothing)
        if (!experienceFound || !data.company) {
            const newExpSection = document.querySelector('div[data-testid^="profile_ExperienceTopLevelSection_"]');
            if (newExpSection) {
                // Get the first item in the list
                const firstItem = newExpSection.querySelector('div[componentkey^="entity-collection-item"]');
                if (firstItem) {
                    // Check for Multi-Role (New Layout): Look for a nested list (ul > li)
                    const subItems = firstItem.querySelectorAll('ul > li');
                    
                    if (subItems.length > 0) {
                        // --- Multi-Role (New Layout) ---
                        const topPtags = firstItem.querySelectorAll(':scope > div > div > div p'); 
                        if (topPtags.length > 0) {
                            const logo = firstItem.querySelector('img');
                            if (logo && logo.alt) {
                                data.company = logo.alt.replace(' logo', '').trim();
                            } else {
                                data.company = topPtags[0].innerText.trim();
                            }
                        }

                        const firstSubItem = subItems[0];
                        const roleP = firstSubItem.querySelector('span[aria-hidden="true"]') || firstSubItem.querySelector('p');
                        if (roleP) data.job_position = roleP.innerText.trim();

                    } else {
                        // --- Single-Role (New Layout) ---
                        const pTags = firstItem.querySelectorAll('p');
                        if (pTags.length > 0) {
                            data.job_position = pTags[0].innerText.trim();
                        }
                        if (pTags.length > 1) {
                            data.company = pTags[1].innerText.split('·')[0].trim();
                        }
                    }

                    const logo = firstItem.querySelector('img');
                    if (logo) data.company_photo = logo.src;
                    const link = firstItem.querySelector('a');
                    if (link) data.company_linkedin_url = link.href;
                }
            }
        }

        // --- 4. Contact Info ---
        let extraContactInfo = [], websiteList = [];

        // A. SVG-based Scraping
        
        // Email
        const emailIcon = document.querySelector('svg[id="envelope-medium"]');
        if (emailIcon) {
            const link = emailIcon.closest('section, div.da4fbff4')?.querySelector('a[href^="mailto:"]');
            if (link) data.email = link.href.replace('mailto:', '').trim();
        }

        // Phone
        const phoneIcon = document.querySelector('svg[id="phone-handset-small"]');
        if (phoneIcon) {
            const container = phoneIcon.closest('section, div.da4fbff4');
            if (container) {
                const texts = Array.from(container.querySelectorAll('span, p')).map(el => el.innerText.trim());
                const number = texts.find(t => t.match(/^[\d\+\-\(\) ]+$/) && t.length > 5);
                if (number) data.phone = number;
            }
        }

        // Birthday
        const birthdayIcon = document.querySelector('svg[id="calendar-medium"]');
        if (birthdayIcon) {
            const container = birthdayIcon.closest('section, div.da4fbff4');
            if (container) {
                const texts = Array.from(container.querySelectorAll('p')).map(el => el.innerText.trim());
                const birthdayText = texts.find(t => t !== 'Birthday' && t.length > 0);
                if (birthdayText) data.birthday = birthdayText;
            }
        }

        // Website/Portfolio (External Links)
        const linkIcon = document.querySelector('svg[id="link-medium"]');
        if (linkIcon) {
             const container = linkIcon.closest('section, div.da4fbff4');
             if (container) {
                 const links = container.querySelectorAll('a');
                 links.forEach(l => {
                     let cleanUrl = l.href;
                     try {
                         const urlObj = new URL(l.href);
                         if (urlObj.hostname.includes('linkedin.com') && urlObj.searchParams.has('url')) {
                             cleanUrl = urlObj.searchParams.get('url');
                         }
                     } catch (e) { /* ignore invalid urls */ }

                     // Avoid linkedin internal profile links
                     if (!cleanUrl.includes('linkedin.com/in/')) { 
                        websiteList.push({ url: cleanUrl, desc: l.innerText.trim() });
                     }
                 });
             }
        }

        // B. Fallback to Old Class-Based Modal Scraping
        // Also look for the Profile Link here to override the potentially dirty URL
        const contactInfoModal = document.querySelector('.artdeco-modal__content');
        if (contactInfoModal) {
            contactInfoModal.querySelectorAll('section.pv-contact-info__contact-type').forEach(section => {
                const header = section.querySelector('h3.pv-contact-info__header')?.innerText.trim().toLowerCase() || "";
                if (!header) return;
                
                // Prioritize the clean profile URL found in the modal
                if (header.includes('profile')) {
                    const profileLink = section.querySelector('a')?.href;
                    if (profileLink) {
                        data.website = profileLink; // Set the main website field to the clean profile link
                        data.url = profileLink; // Update the internal URL field too
                    }
                }
                else if (header.includes('email') && !data.email) data.email = section.querySelector('a')?.href.replace('mailto:', '') || '';
                else if (header.includes('phone') && !data.phone) data.phone = section.querySelector('.t-14 span')?.innerText.trim() || '';
                else if (header.includes('websites') && websiteList.length === 0) {
                    section.querySelectorAll('li a').forEach(l => {
                        let cleanUrl = l.href;
                        try {
                            const urlObj = new URL(l.href);
                            if (urlObj.hostname.includes('linkedin.com') && urlObj.searchParams.has('url')) {
                                cleanUrl = urlObj.searchParams.get('url');
                            }
                        } catch (e) {}
                        websiteList.push({ url: cleanUrl, desc: l.nextElementSibling?.innerText.trim() || '' });
                    });
                }
                else if (header.includes('birthday') && !data.birthday) {
                    data.birthday = section.querySelector('.t-14 span')?.innerText.trim() || '';
                }
            });
        }

        // Format Additional Info for Odoo (Clean & Readable)
        let parts = [];
        
        if (websiteList.length > 0) {
            const uniqueWebsites = [];
            const seenUrls = new Set();
            websiteList.forEach(w => {
                if (!seenUrls.has(w.url)) {
                    seenUrls.add(w.url);
                    uniqueWebsites.push(w);
                }
            });

            parts.push("Websites:");
            uniqueWebsites.forEach(w => {
                const desc = w.desc ? ` (${w.desc})` : '';
                parts.push(`${w.url}${desc}`);
            });
            parts.push(""); // Spacing
        }

        if (data.birthday) {
            parts.push(`Birthday: ${data.birthday}`);
            parts.push(""); // Spacing
        }

        if (data.additional_info) {
            parts.push("About:");
            parts.push(data.additional_info);
            parts.push("");
        }

        if (extraContactInfo.length > 0) {
            parts.push("Other Info:");
            parts.push(extraContactInfo.join('\n'));
        }
        
        data.additional_info = parts.join('\n').trim();

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
        const contactInfoLink = Array.from(document.querySelectorAll('a')).find(a => 
            (a.id && a.id.includes('contact-info')) || 
            (a.innerText && a.innerText.toLowerCase().includes('contact info'))
        );

        if (contactInfoLink) {
            contactInfoLink.click();
            // 3. Wait for modal. Wait for the header or dismiss button to appear
            await new Promise(resolve => {
                let attempts = 0;
                const checkModal = setInterval(() => {
                    attempts++;
                    const modal = document.querySelector('.artdeco-modal__content') || document.querySelector('.artdeco-modal__dismiss');
                    if (modal || attempts > 10) { // Stop after ~2 seconds or if found
                        clearInterval(checkModal);
                        resolve();
                    }
                }, 200);
            }); 
            
            // 4. Scrape modal and merge data
            const contactData = scrapeLinkedInProfile();
            
            // Merge, prioritizing modal data for these fields
            // Prioritize the profile URL from modal (contactData.website) over current page URL
            if (contactData.website && contactData.website !== data.website) {
                data.website = contactData.website;
                data.url = contactData.website; // Ensure consistency
            }
            
            data.email = contactData.email || data.email;
            data.phone = contactData.phone || data.phone;
            data.birthday = contactData.birthday || data.birthday;
            
            // Recalculate additional info based on merged data to keep it clean
            if (contactData.additional_info && contactData.additional_info.length > (data.additional_info?.length || 0)) {
                 data.additional_info = contactData.additional_info;
            }
            
            // 5. Close modal
            const closeButton = document.querySelector('.artdeco-modal__dismiss') || 
                                document.querySelector('button[aria-label="Dismiss"]');
            if (closeButton) closeButton.click();
        }
    } catch (e) {
        console.error("Scrape Orchestration Error:", e);
        // Try to close modal if it's open, then re-throw
        const closeButton = document.querySelector('.artdeco-modal__dismiss') || 
                            document.querySelector('button[aria-label="Dismiss"]');
        if (closeButton) closeButton.click();
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

    const name = document.querySelector('h1')?.innerText?.trim().split('\n')[0].trim() || 
                 document.querySelector("div[data-view-name='profile-top-card-verified-badge'] p")?.innerText.trim();
                 
    if (!name) {
        updateButtonState(); // No name found, keep button disabled
        return;
    }
    
    button.style.display = 'flex'; // Ensure visible

    try {
        const backendUrl = odooCredentials.backend_url.replace(/\/+$/, '');
        const res = await fetch(`${backendUrl}/check_contact`, {
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
        // Refresh credentials to avoid stale data
        const storage = await chrome.storage.local.get(['odoo_server', 'odoo_db_name', 'username', 'api_token', 'backend_url', 'currentCampaignId']);
        // Update global variable just in case
        odooCredentials = {
            odoo_server: storage.odoo_server,
            odoo_db_name: storage.odoo_db_name,
            username: storage.username,
            api_token: storage.api_token,
            backend_url: storage.backend_url
        };

        // Sanitize backend URL (remove trailing slash)
        if (!odooCredentials.backend_url) throw new Error("Backend URL is missing in Options.");
        const backendUrl = odooCredentials.backend_url.replace(/\/+$/, '');

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
        
        // 2. Fetch all campaigns and the current campaign ID
        let campaigns = [];
        try {
            console.log("Fetching campaigns from:", `${backendUrl}/campaigns`);
            const campaignsResponse = await fetch(`${backendUrl}/campaigns`);
            if (campaignsResponse.ok) {
                campaigns = await campaignsResponse.json();
            }
        } catch (e) {
            console.warn("Could not load campaigns (ignoring):", e);
        }
        
        const currentCampaignId = storage.currentCampaignId;

        let campaignTags = { person_tags: [], company_tags: [] };
        if (currentCampaignId && campaigns.length > 0) {
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
        console.log("Sending contact to:", `${backendUrl}/create_contact`);
        const res = await fetch(`${backendUrl}/create_contact`, {
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
            // Explicitly mention Mixed Content for the user
            errorMsg = "Connection Error (Check Backend URL or Mixed Content blocking)";
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