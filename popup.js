class AIFormFiller {
  constructor() {
    this.tabs = [
    {
        "content": "Stanislav D.\r\n44 y.o.\r\nChief Technology Officer (CTO), Vice President of Production\r\n2017-Present\r\nEuropean Union, Remote\r\n+7 995 664 9220 / WhatsApp / leadbit.flash1@gmail.com\r\n500+ projects, 20+ games, 400 million players\r\n\r\n2011 Establishing Peak Casual\r\n2001-2010 LeadBit, \r\ncooperation with BridgeStone and Symantec Europe\r\n\r\nA highly skilled and dedicated Producer and Software Engineer with a strong background in cutting-edge GameDev technologies, including visual content creation, animation techniques, and custom game engine development. With a proven track record of success in managing more than 500 completed projects and reaching millions of users worldwide, I offer unparalleled expertise in driving product growth, user engagement, and revenue generation while ensuring a seamless gaming experience. Leveraging excellent communication, leadership, and creative problem-solving abilities, I am eager to contribute my extensive knowledge and experience to a challenging role in the gaming industry.\r\n\r\nACHIEVEMENTS:\r\n\r\n- Successfully led and managed over 500 projects, including more than 20 popular casual games on Facebook between 2011 and 2023.\r\n- Reached over 400 million users globally, showcasing a strong understanding of user preferences and gaming trends.\r\n- Contributed to the significant financial success of multiple games, including “Toon Blast”, earning nearly $1 billion in 2020.\r\n- Led the company through a strategic partnership with Peak Games, resulting in company rebranding and acquisition.\r\n\r\nSKILLS & TECHNICAL PROFICIENCIES:\r\n\r\n- Proficient in various GameDev technologies, including OpenGl/WebGl, VR, UNITY, THREE.JS evangelist, C++/#, WEBSOCKET, OPENAI, Backend Clusterization, and more.\r\n- Agile Methodology, DevOps, Data Analysis, User Acquisition (UA), User Interface (UI)/User Experience (UX) Design, Version Control Systems (Git, SVN), Cloud Platforms (AWS, Azure, GCP).\r\n- Playtesting and User Feedback Analysis, Game Analytics and Data Visualization, Performance Optimization Techniques, Cross-Platform Development Strategies, Marketing Automation Tools and Techniques, Community Management and Social Media Marketing, Design Thinking and User Research Methods.\r\n- Solid understanding of visual content creation, animation techniques, graphics technology, and custom game engine development to drive product innovation and marketability.\r\n- Expertise in project management, team leadership, and collaboration, resulting in the successful delivery of numerous high-quality gaming projects.\r\n- Language proficiency in English (Advanced/C1), Romanian (Intermediate), and Russian (Native).\r\n\r\n\r\nSUMMARY OF QUALIFICATIONS:\r\n\r\n- Over 15 years of experience in the gaming and software development industries, including executive and management positions.\r\n- Strong technical background with a proven track record of successful game development, marketing, and monetization.\r\n- Proficient in project management, team leadership, and business development.\r\n\r\nPROFESSIONAL EXPERIENCE:\r\n\r\n2017-Present: Co-Founder, Chief Technology Officer (CTO) and Vice President of Production, Acrobatic Games\r\n\r\n- Oversaw the development and success of Toon Blast, which earned nearly $1 billion in revenue by 2020.\r\n- Collaborated with Peak Games in 2012 to rebrand the company, joining forces to create popular titles including Lost Bubble and Lost Jewels.\r\n- Managed a strong portfolio of games, helping to grow the company and ultimately resulting in its acquisition by Peak Games.\r\n\r\n2011-2017: Co-Founder, Chief Operating Officer (COO) and Vice President of Production, Peak Casual\r\n\r\n- Initiated the development of casual games, resulting in the successful launch of the Sultan Bubble series of games.\r\n- Grew the game's Facebook presence to reach over 1 million daily active users in just two weeks and eventually achieved 5 million daily active users in one month.\r\n- Settled a lawsuit with King.com over intellectual property disputes for over £1 million.\r\n\r\n2001-2011: Founder and CEO, LeadBit - The Outsourcing Company\r\n\r\n- Completed over 500 projects for major clients including Bridgestone and Symantec Europe, consistently delivering high-quality results that met or exceeded client expectations.\r\n- Built and managed a diverse team of software and game developers, integrating various skill sets to deliver effective solutions for clients.\r\n- Developed and published the first three games for Nokia's Ovi Store, winning the top three places in a Nokia competition.\r\n\r\nEDUCATION:\r\n\r\nBachelor of Science in Computer Science (College of Informatics, Government State University)\r\n\r\nPROFESSIONAL SKILLS:\r\n\r\n- Game Development: Strong experience in developing, marketing and monetizing successful casual games.\r\n- Technical Expertise: Proficient in various programming languages and development tools, with a deep understanding of game design concepts.\r\n- Project Management: Expert in managing multiple projects simultaneously, ensuring timely delivery and adherence to strict quality standards.\r\n- Team Leadership: Strong ability to build, lead, and motivate teams of varying sizes and skill sets.\r\n- Business Development: Track record of identifying and capitalizing on new opportunities to grow and expand the company.\r\n\r\n\r\nReferences available upon request.",
        "id": "tab-1760029488841-fv4lodytj",
        "name": "!MY RESUME!.txt"
    }
]
    this.activeTabId = "tab-1760029488841-fv4lodytj";
    this.aiSession = null;
    this.isProcessing = false;
    this.init();
  }

  async init() {
    await this.ensureContentScriptInjected();
    this.setupEventListeners();
    this.setupMessageListener(); // Centralized message listener
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
  
  // NEW: Centralized message listener
  setupMessageListener() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.action === 'extractedFormData') {
        this.createExtractedDataTab(msg.data);
      }

      if (msg.action === 'aiStatus') {
        const statusIndicator = document.querySelector('.status-indicator');
        const statusText = document.querySelector('.status-text');
        const fillFormsBtn = document.getElementById('fillFormsBtn');
        
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
  }
  
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

async extractFormData() {
  await this.ensureContentScriptInjected();
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab found.");
    
    // Send message to content script to extract data
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'extractFormData'
    });
    
    if (response && response.data) {
      this.createExtractedDataTab(response.data);
    } else {
      alert('No form data found to extract. Please fill a form first.');
    }
  } catch (e) {
    console.error('Failed to extract form data:', e);
    alert('Could not extract form data. Please ensure you have filled a form on the current page.');
  }
}

setupEventListeners() {
    const dropArea = document.getElementById('dropArea');
    const fileInput = document.getElementById('fileInput');

    // NEW TAB BUTTON EVENT LISTENER
    document.getElementById('newTabBtn').addEventListener('click', () => {
      this.createNewEmptyTab();
    });

    // EXTRACT DATA BUTTON EVENT LISTENER
    document.getElementById('extractDataBtn').addEventListener('click', () => {
      this.extractFormData();
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

  // NEW METHOD: Create tab from extracted form data
  createExtractedDataTab(formattedData) {
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date().toLocaleTimeString();
    
    this.tabs.push({
      id: tabId,
      name: `📋 Form Data ${timestamp}`,
      content: formattedData
    });

    this.renderTabs();
    this.setActiveTab(tabId);
    this.saveTabs();
    
    // Show a notification in the popup
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: absolute;
      bottom: 60px; /* Position above buttons */
      left: 50%;
      transform: translateX(-50%);
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 10px 15px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 10000;
      font-family: sans-serif;
      font-size: 13px;
      white-space: nowrap;
    `;
    notification.textContent = '✅ Data extracted to new tab!';
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.transition = 'opacity 0.5s';
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 500);
    }, 2500);
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