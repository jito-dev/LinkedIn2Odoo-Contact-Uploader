/**
 * Background service worker for the extension.
 * Listens for navigation events to re-initialize the content script
 * on LinkedIn's single-page application (SPA) navigations.
 */

chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    /**
     * Fires when the URL changes without a full page reload (e.g., SPA).
     * We check if the new URL is a LinkedIn profile page.
     */
    if (details.url && details.url.includes("linkedin.com/in/")) {
      // Send a message to the content script in that tab to re-run its logic.
      chrome.tabs.sendMessage(details.tabId, { action: "navigate" });
    }
  },
  { url: [{ hostContains: ".linkedin.com" }] } // Only listen for events on LinkedIn
);