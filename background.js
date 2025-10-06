// Background service worker for handling extension lifecycle
chrome.runtime.onInstalled.addListener(() => {
  console.log('AI Form Filler Extension installed');
  
  // Set default settings
  chrome.storage.local.set({
    settings: {
      autoDetect: true,
      showLabels: true,
      aiEnabled: true
    }
  });
});

// Handle extension icon click (if not using popup)
chrome.action.onClicked.addListener((tab) => {
  // This won't be called if we have a default_popup
  // But keeping for potential future use
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js']
  });
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getAIStatus') {
    // Check AI availability from background
    checkAIAvailability().then(status => {
      sendResponse({ status });
    });
    return true; // Keep channel open for async response
  }
});

async function checkAIAvailability() {
  try {
    if ('ai' in self && 'languageModel' in self.ai) {
      const capabilities = await self.ai.languageModel.capabilities();
      return capabilities.available;
    }
  } catch (error) {
    console.error('AI check error:', error);
  }
  return 'no';
}