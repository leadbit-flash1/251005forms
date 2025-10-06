class AIFormFiller {
  constructor() {
    this.tabs = [];
    this.activeTabId = null;
    this.aiSession = null;
    this.isProcessing = false;
    this.init();
  }

  async init() {
    await this.ensureContentScriptInjected();
    this.setupEventListeners();
    await this.checkAIAvailability();
    this.loadSavedTabs();
    this.loadHFSettings();
  }

  async ensureContentScriptInjected() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;

      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
      } catch (e) {
        console.log('Injecting content script...');
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ['content.css']
        });
        
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (e) {
      console.error('Failed to inject content script:', e);
    }
  }
  
// popup.js - updated checkAIAvailability method only

async checkAIAvailability() {
  const statusIndicator = document.querySelector('.status-indicator');
  const statusText = document.querySelector('.status-text');
  const fillFormsBtn = document.getElementById('fillFormsBtn');

  statusIndicator.className = 'status-indicator';
  statusText.textContent = 'Checking AI status...';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      throw new Error("No active tab found.");
    }
    
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ error: 'timeout' }), 3000);
    });
    
    const messagePromise = chrome.tabs.sendMessage(tab.id, { action: 'checkAI' });
    
    const resp = await Promise.race([messagePromise, timeoutPromise]);
    
    if (resp?.error === 'timeout') {
      console.log('AI check timed out, using Llama.');
      statusIndicator.classList.add('ready');
      statusText.textContent = 'Using Llama 3.2';
    }
  } catch (e) {
    console.log('Could not check AI, using Llama:', e);
    statusIndicator.classList.add('ready');
    statusText.textContent = 'Using Llama 3.2';
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'aiStatus') {
      const caps = msg.payload || {};
      if (caps.available === 'readily') {
        statusIndicator.classList.remove('error');
        statusIndicator.classList.add('ready');
        // Display the model name from the bridge
        statusText.textContent = caps.model || 'Using Llama 3.2';
        fillFormsBtn.disabled = false;
      } else {
        // Even if not available, we'll use Llama
        statusIndicator.classList.remove('error');
        statusIndicator.classList.add('ready');
        statusText.textContent = 'Using Llama 3.2';
        fillFormsBtn.disabled = false;
      }
    }
    
    if (msg.action === 'processingComplete') {
      this.isProcessing = false;
      const fillFormsBtn = document.getElementById('fillFormsBtn');
      fillFormsBtn.disabled = false;
      fillFormsBtn.innerHTML = '<span class="btn-icon">🤖</span>FILL FORMS';
    }
  });

  fillFormsBtn.disabled = false;
}
  async fillForms() {
    if (this.isProcessing) return;
    
    const activeTab = this.tabs.find(tab => tab.id === this.activeTabId);
    
    if (!activeTab) {
      alert('Please select or upload a document first.');
      return;
    }

    await this.ensureContentScriptInjected();

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error("No active tab found.");
      
      this.isProcessing = true;
      const fillFormsBtn = document.getElementById('fillFormsBtn');
      fillFormsBtn.disabled = true;
      fillFormsBtn.innerHTML = '<span class="btn-icon">⏳</span>PROCESSING...';
      
      await chrome.tabs.sendMessage(tab.id, {
        action: 'fillForms',
        context: activeTab.content,
        useAI: true
      });
    } catch (e) {
      console.error('Failed to send message to content script:', e);
      alert('Could not communicate with the page. Please refresh the page and try again.');
      this.isProcessing = false;
      const fillFormsBtn = document.getElementById('fillFormsBtn');
      fillFormsBtn.disabled = false;
      fillFormsBtn.innerHTML = '<span class="btn-icon">🤖</span>FILL FORMS';
    }
  }

  setupEventListeners() {
    const dropArea = document.getElementById('dropArea');
    const fileInput = document.getElementById('fileInput');

    // NEW TAB BUTTON EVENT LISTENER
    document.getElementById('newTabBtn').addEventListener('click', () => {
      this.createNewEmptyTab();
    });

    dropArea.addEventListener('click', () => fileInput.click());
    
    dropArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropArea.classList.add('dragging');
    });

    dropArea.addEventListener('dragleave', () => {
      dropArea.classList.remove('dragging');
    });

    dropArea.addEventListener('drop', (e) => {
      e.preventDefault();
      dropArea.classList.remove('dragging');
      this.handleFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', (e) => {
      this.handleFiles(e.target.files);
    });

    document.getElementById('fillFormsBtn').addEventListener('click', () => this.fillForms());
    document.getElementById('clearBtn').addEventListener('click', () => this.clearAllTabs());
    document.getElementById('settingsBtn').addEventListener('click', () => this.toggleSettings());
    document.getElementById('saveHFSettings').addEventListener('click', () => this.saveHFSettings());
  }

  // NEW METHOD: Create a new empty tab
  createNewEmptyTab() {
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const tabNumber = this.tabs.filter(t => t.name.startsWith('New Tab')).length + 1;
    
    this.tabs.push({
      id: tabId,
      name: `New Tab ${tabNumber}`,
      content: ''
    });

    this.renderTabs();
    this.setActiveTab(tabId);
    this.saveTabs();

    // Focus on the textarea for the new tab
    setTimeout(() => {
      const textarea = document.querySelector(`.editable-content[data-tab="${tabId}"]`);
      if (textarea) textarea.focus();
    }, 100);
  }

  toggleSettings() {
    const panel = document.getElementById('hfSettingsPanel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }

  async saveHFSettings() {
    const token = document.getElementById('hfToken').value.trim();
    const model = document.getElementById('hfModel').value.trim();
    
    await chrome.storage.local.set({ 
      hfToken: token,
      hfModel: model || 'meta-llama/Llama-3.2-3B-Instruct:novita'
    });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, { action: 'updateHFToken' });
      }
    } catch (e) {
      console.log('Content script not ready to receive HF token update.');
    }

    document.getElementById('hfSaveStatus').textContent = 'Settings saved!';
    setTimeout(() => {
      document.getElementById('hfSaveStatus').textContent = '';
    }, 2000);

    await this.checkAIAvailability();
  }

  async loadHFSettings() {
    const result = await chrome.storage.local.get(['hfToken', 'hfModel']);
    if (result.hfToken) {
      document.getElementById('hfToken').value = result.hfToken;
    }
    if (result.hfModel) {
      document.getElementById('hfModel').value = result.hfModel;
    } else {
      document.getElementById('hfModel').value = 'meta-llama/Llama-3.2-3B-Instruct:novita';
    }
  }

  handleFiles(files) {
    Array.from(files).forEach(file => {
      if (file.type.startsWith('text/') || file.name.endsWith('.txt')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          this.addTab(file.name, e.target.result);
        };
        reader.readAsText(file);
      }
    });
  }

  addTab(name, content) {
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    this.tabs.push({
      id: tabId,
      name: name.length > 20 ? name.substring(0, 20) + '...' : name,
      content: content
    });

    this.renderTabs();
    this.setActiveTab(tabId);
    this.saveTabs();
  }

  renderTabs() {
    const tabsHeader = document.getElementById('tabsHeader');
    const tabsContent = document.getElementById('tabsContent');

    // Always keep the New Tab button
    const newTabButton = '<button id="newTabBtn" class="new-tab-button" title="Create new empty tab"><span>+ New Tab</span></button>';

    if (this.tabs.length === 0) {
      tabsHeader.innerHTML = newTabButton + '<div style="padding: 10px; color: #999; display: inline-block;">No documents uploaded</div>';
      tabsContent.innerHTML = '';
      // Re-attach event listener
      document.getElementById('newTabBtn').addEventListener('click', () => this.createNewEmptyTab());
      return;
    }

    tabsHeader.innerHTML = newTabButton + this.tabs.map(tab => `
      <button class="tab-button ${tab.id === this.activeTabId ? 'active' : ''}" data-tab="${tab.id}">
        <span>${tab.name}</span>
        <button class="tab-close" data-tab="${tab.id}">×</button>
      </button>
    `).join('');

    tabsContent.innerHTML = this.tabs.map(tab => `
      <div class="tab-panel ${tab.id === this.activeTabId ? 'active' : ''}" data-tab="${tab.id}">
        <textarea class="editable-content" data-tab="${tab.id}" placeholder="Enter or edit text here...">${tab.content}</textarea>
      </div>
    `).join('');

    // Re-attach all event listeners
    document.getElementById('newTabBtn').addEventListener('click', () => this.createNewEmptyTab());

    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        if (!e.target.classList.contains('tab-close')) {
          this.setActiveTab(btn.dataset.tab);
        }
      });
    });

    document.querySelectorAll('.tab-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeTab(btn.dataset.tab);
      });
    });

    document.querySelectorAll('.editable-content').forEach(textarea => {
      textarea.addEventListener('input', (e) => {
        const tab = this.tabs.find(t => t.id === e.target.dataset.tab);
        if (tab) {
          tab.content = e.target.value;
          this.saveTabs();
        }
      });
    });
  }

  setActiveTab(tabId) {
    this.activeTabId = tabId;
    
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('active', panel.dataset.tab === tabId);
    });
  }

  removeTab(tabId) {
    this.tabs = this.tabs.filter(tab => tab.id !== tabId);
    
    if (this.activeTabId === tabId && this.tabs.length > 0) {
      this.activeTabId = this.tabs[0].id;
    } else if (this.tabs.length === 0) {
      this.activeTabId = null;
    }
    
    this.renderTabs();
    this.saveTabs();
  }

  clearAllTabs() {
    if (confirm('Are you sure you want to clear all documents?')) {
      this.tabs = [];
      this.activeTabId = null;
      this.renderTabs();
      this.saveTabs();
    }
  }

  saveTabs() {
    chrome.storage.local.set({ 
      tabs: this.tabs,
      activeTabId: this.activeTabId 
    });
  }

  loadSavedTabs() {
    chrome.storage.local.get(['tabs', 'activeTabId'], (result) => {
      if (result.tabs && result.tabs.length > 0) {
        this.tabs = result.tabs;
        this.activeTabId = result.activeTabId || this.tabs[0].id;
        this.renderTabs();
        this.setActiveTab(this.activeTabId);
      } else {
        // Still render to show the New Tab button
        this.renderTabs();
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new AIFormFiller();
});