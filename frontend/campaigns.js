/**
 * This script manages the "Campaigns" section of the options.html page.
 * It handles creating, reading, updating, and deleting (CRUD) campaigns
 * by communicating with the backend API.
 * It also manages setting the "current campaign" in chrome.storage.local.
 */

let BACKEND_URL = ''; // Will be loaded from storage
let currentPersonTags = [];
let currentCompanyTags = [];

// A list of common tags to suggest to the user
const predefinedTags = [
    "B2B", "B2C", "B2G", "SaaS", "PaaS", "D2C", "FinTech", "eCommerce", "Start-up / Startup", "SMB", "Enterprise",
    "VIP", "C-Suite", "Executive", "Manager / MGMT", "SR", "PM", "TBD", "MVP", "Key Account", "Premium",
    "Consulting", "Strategy", "Training / L&D", "Coaching", "Marketing / MKTG", "Sales", "HR", "Finance / FNCE", "Legal", "IT", "DevOps", "R&D", "Compliance", "Analytics", "SEO", "CRM"
];

/**
 * Sets up an input field to be a tag/pill input with an optional autocomplete dropdown.
 * @param {string} inputId - The ID of the <input> element.
 * @param {string} dropdownId - The ID of the dropdown <div> element.
 * @param {function} getTagsArray - A function that returns the array to add tags to.
 * @param {string} containerId - The ID of the container to render pills in.
 */
function setupTagInput(inputId, dropdownId, getTagsArray, containerId) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);

    /**
     * Adds a tag to the corresponding array if it's not a duplicate.
     * @param {string} value - The tag value to add.
     */
    const onAdd = (value) => {
        const tagsArray = getTagsArray();
        const trimmedValue = value.trim();
        if (trimmedValue && !tagsArray.includes(trimmedValue)) {
            tagsArray.push(trimmedValue);
            renderCampaignTags(); // Re-render all pills
        }
        input.value = '';
        if(dropdown) dropdown.classList.add('hidden');
    };

    // Add tag on 'Enter' key press
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            onAdd(input.value);
        }
    });

    // Handle the autocomplete dropdown logic
    if (dropdown) {
        input.addEventListener('input', () => {
            const filter = input.value.toLowerCase();
            if (!filter) {
                dropdown.classList.add('hidden');
                return;
            }
            dropdown.innerHTML = '';
            // Filter predefined tags based on input
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
        // Hide dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!input.contains(e.target)) dropdown.classList.add('hidden');
        });
    }
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
 * A specific render function to update both person and company tag containers.
 */
function renderCampaignTags() {
    renderPills('campaign-person-tags-container', currentPersonTags, (i) => {
        currentPersonTags.splice(i, 1);
        renderCampaignTags();
    });
    renderPills('campaign-company-tags-container', currentCompanyTags, (i) => {
        currentCompanyTags.splice(i, 1);
        renderCampaignTags();
    });
}

/**
 * Fetches all campaigns from the backend and renders them in the list
 * and the "Current Campaign" dropdown.
 */
async function fetchAndRenderCampaigns() {
    let campaigns = [];
    try {
        // Load backend_url from storage first
        const storage = await chrome.storage.local.get('backend_url');
        BACKEND_URL = storage.backend_url;
        if (!BACKEND_URL) {
            alert("Backend URL not set in options.");
            return;
        }

        const response = await fetch(`${BACKEND_URL}/campaigns`);
        campaigns = await response.json();
    } catch (e) {
        console.error("Failed to fetch campaigns", e);
        alert("Failed to load campaigns from backend.");
        return;
    }

    const list = document.getElementById('campaignList');
    const select = document.getElementById('currentCampaign');
    list.innerHTML = '';
    select.innerHTML = '<option value="">None</option>';
    
    // Get the currently selected campaign from storage
    chrome.storage.local.get('currentCampaignId', (result) => {
        const currentCampaignId = result.currentCampaignId || null;

        campaigns.forEach(campaign => {
            // Populate the list of existing campaigns
            const li = document.createElement('li');
            li.innerHTML = `
                <h4>${campaign.name}</h4>
                <p><strong>Person Tags:</strong> ${campaign.person_tags.join(', ') || 'None'}</p>
                <p><strong>Company Tags:</strong> ${campaign.company_tags.join(', ') || 'None'}</p>
                <button class="delete-campaign" data-id="${campaign.id}">Delete</button>
            `;
            li.addEventListener('click', (e) => {
                if (e.target.classList.contains('delete-campaign')) {
                    e.stopPropagation(); // Prevent edit when clicking delete
                    deleteCampaign(campaign.id);
                } else {
                    editCampaign(campaign.id, campaigns); // Click list item to edit
                }
            });
            list.appendChild(li);

            // Populate the "Set Current Campaign" dropdown
            const option = document.createElement('option');
            option.value = campaign.id;
            option.textContent = campaign.name;
            if (campaign.id === currentCampaignId) {
                option.selected = true;
            }
            select.appendChild(option);
        });
    });
}

/**
 * Saves the campaign currently in the "Create/Edit" form.
 * Performs a POST if no ID is present, or a PUT if an ID exists.
 */
async function saveCampaign() {
    // Ensure BACKEND_URL is loaded
    if (!BACKEND_URL) {
        const storage = await chrome.storage.local.get('backend_url');
        BACKEND_URL = storage.backend_url;
        if (!BACKEND_URL) {
            alert("Backend URL not set in options.");
            return;
        }
    }

    const campaignId = document.getElementById('campaignId').value;
    const campaignName = document.getElementById('campaignName').value;
    
    if (!campaignName) {
        alert("Campaign name is required.");
        return;
    }

    const method = campaignId ? 'PUT' : 'POST';
    const url = campaignId ? `${BACKEND_URL}/campaigns/${campaignId}` : `${BACKEND_URL}/campaigns`;

    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: campaignName,
                person_tags: [...new Set(currentPersonTags)], // Send unique tags
                company_tags: [...new Set(currentCompanyTags)] // Send unique tags
            })
        });
        if (!res.ok) throw new Error('Failed to save campaign');
        
        // Clear the form
        document.getElementById('campaignId').value = '';
        document.getElementById('campaignName').value = '';
        currentPersonTags.length = 0;
        currentCompanyTags.length = 0;
        renderCampaignTags();
        fetchAndRenderCampaigns(); // Refresh the list
    } catch (e) {
        console.error("Failed to save campaign:", e);
        alert("Error: Could not save campaign to backend.");
    }
}

/**
 * Populates the "Create/Edit" form with a campaign's data for editing.
 * @param {string} campaignId - The ID of the campaign to edit.
 * @param {Array} campaigns - The full list of campaigns (to avoid re-fetching).
 */
function editCampaign(campaignId, campaigns) {
    const campaign = campaigns.find(c => c.id === campaignId);
    if (!campaign) return;

    // Populate form fields
    document.getElementById('campaignId').value = campaign.id;
    document.getElementById('campaignName').value = campaign.name;
    
    // Clear and re-populate tag arrays
    currentPersonTags.length = 0;
    if (campaign.person_tags) {
        currentPersonTags.push(...campaign.person_tags);
    }

    currentCompanyTags.length = 0;
    if (campaign.company_tags) {
        currentCompanyTags.push(...campaign.company_tags);
    }
    
    renderCampaignTags(); // Re-render pills
}


/**
 * Deletes a campaign by its ID and refreshes the list.
 * @param {string} campaignId - The ID of the campaign to delete.
 */
async function deleteCampaign(campaignId) {
    if (!confirm("Are you sure you want to delete this campaign?")) return;
    
    try {
        // Ensure BACKEND_URL is loaded
        if (!BACKEND_URL) {
            const storage = await chrome.storage.local.get('backend_url');
            BACKEND_URL = storage.backend_url;
            if (!BACKEND_URL) {
                alert("Backend URL not set in options.");
                return;
            }
        }

        await fetch(`${BACKEND_URL}/campaigns/${campaignId}`, { method: 'DELETE' });
        
        // If this was the active campaign, clear the setting
        chrome.storage.local.get('currentCampaignId', (result) => {
            if (result.currentCampaignId === campaignId) {
                chrome.storage.local.set({ currentCampaignId: null });
            }
        });

        fetchAndRenderCampaigns();
    } catch (e) {
        console.error("Failed to delete campaign:", e);
        alert("Error: Could not delete campaign.");
    }
}

/**
 * Updates `chrome.storage.local` with the currently selected "active" campaign.
 * @param {string} campaignId - The ID of the campaign to set as current.
 */
function setCurrentCampaign(campaignId) {
    // Save to local storage, not backend
    chrome.storage.local.set({ currentCampaignId: campaignId || null }, () => {
        console.log("Current campaign set in local storage:", campaignId);
    });
}

// Initial setup when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    fetchAndRenderCampaigns(); // Load all campaigns
    document.getElementById('btnSaveCampaign').addEventListener('click', saveCampaign);
    
    // Listen for changes to the active campaign dropdown
    document.getElementById('currentCampaign').addEventListener('change', (e) => {
        setCurrentCampaign(e.target.value);
    });

    // Initialize the tag inputs
    setupTagInput('campaign-person-tags-input', 'campaign-person-tags-dropdown', () => currentPersonTags, 'campaign-person-tags-container');
    setupTagInput('campaign-company-tags-input', 'campaign-company-tags-dropdown', () => currentCompanyTags, 'campaign-company-tags-container');
});
