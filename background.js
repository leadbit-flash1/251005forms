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


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'callHuggingFace') {
    // Make the actual API call from background script (not subject to CSP)
    fetch("https://router.huggingface.co/v1/chat/completions", {
      headers: {
        Authorization: `Bearer ${request.token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: request.prompt,
          },
        ],
        model: request.model,
        max_tokens: 1000,
        temperature: 0.3
      }),
    })
    .then(response => {
      if (response.status === 401) {
        throw new Error(`Authentication failed (401): Invalid API token`);
      }
      if (!response.ok) {
        return response.text().then(text => {
          throw new Error(`HuggingFace API error: ${response.status} - ${text}`);
        });
      }
      return response.json();
    })
    .then(result => {
      // Extract the actual message content from the chat completion response
      if (result.choices && result.choices[0] && result.choices[0].message) {
        sendResponse({ result: result.choices[0].message.content });
      } else {
        sendResponse({ result: JSON.stringify(result) });
      }
    })
    .catch(error => {
      console.error('HuggingFace API call failed:', error);
      sendResponse({ error: error.message });
    });
    
    return true; // Indicates async response
  }
});