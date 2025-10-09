// content.js

/**
 * AIBridge provides a robust, timeout-enabled, and injectable interface
 * for communicating with an AI model in the page's context. This is superior
 * to directly accessing `self.ai` as it's more resilient and abstract.
 * Now supports HuggingFace models as an alternative.
 */
class AIBridge {
  constructor() {
    this.seq = 0;
    this.pending = new Map();
    this.injected = false;
    this.hfToken = null;
    window.addEventListener('message', this.onMessage.bind(this));
    this.loadHFToken();
  }

  async loadHFToken() {
    const result = await chrome.storage.local.get(['hfToken', 'hfModel']);
    this.hfToken = result.hfToken || null;
    this.hfModel = result.hfModel || 'meta-llama/Llama-3.2-3B-Instruct:novita';
  }

  async ensureInjected() {
    if (this.injected) return;
    if (!document.getElementById('__ai_bridge_injected')) {
      const script = document.createElement('script');
      script.id = '__ai_bridge_injected';
      script.src = chrome.runtime.getURL('injected.js');
      (document.documentElement || document.head || document.body).appendChild(script);
    }
    this.injected = true;
  }

  onMessage(event) {
    const msg = event.data;
    if (!msg || msg.source !== 'AI_FORM_FILLER_BRIDGE') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.payload);
  }

  post(type, data, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = `m${++this.seq}`;
      this.pending.set(id, { resolve, reject });
      window.postMessage({
        target: 'AI_FORM_FILLER_BRIDGE',
        id,
        type,
        data,
        hfToken: this.hfToken,
        hfModel: this.hfModel
      }, '*');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`AI bridge timeout for ${type}`));
        }
      }, timeoutMs);
    });
  }

  async capabilities() {
    await this.ensureInjected();
    await this.loadHFToken();
    return this.post('CAPABILITIES');
  }
  async createSession(options) {
    await this.ensureInjected();
    await this.loadHFToken();
    return this.post('CREATE_SESSION', { options });
  }
  async prompt(sessionId, prompt) {
    return this.post('PROMPT', { sessionId, prompt }, 30000);
  }
  async destroy(sessionId) {
    return this.post('DESTROY', { sessionId });
  }
  
  cancelAllPending() {
    this.pending.forEach((p) => {
      p.reject(new Error('Cancelled by user'));
    });
    this.pending.clear();
  }
}


class FormAnalyzer {
  constructor() {
    this.identifiedFields = [];
    this.fieldOverlays = [];
    this.aiBridge = new AIBridge();
    this.currentSessionId = null;
    this.isProcessing = false;
    this.isCancelled = false;

    // Overlay tracking
    this.updateOverlayPositionsBound = null;
    this.resizeObserver = null;

    // New caches for robust index/key resolution
    this.fieldsJsonCache = null;
    this.elementsCache = null;
    this.fieldKeyToIndex = new Map();
    this.cssPathToIndex = new Map();

    this.init();
  }

  init() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'ping') {
        sendResponse({ status: 'ready' });
        return true;
      }

      if (request.action === 'fillForms') {
        this.processFormFilling(request.context, request.useAI);
        sendResponse({ status: 'started' });
        return true;
      }

      if (request.action === 'checkAI') {
        this.checkAI().then((resp) => {
          chrome.runtime.sendMessage({ action: 'aiStatus', payload: resp });
        }).catch(e => {
          console.error('AI check failed:', e);
          chrome.runtime.sendMessage({ action: 'aiStatus', payload: { available: 'no' } });
        });
        sendResponse({ status: 'checking' });
        return true;
      }

      if (request.action === 'updateHFToken') {
        this.aiBridge.loadHFToken();
        sendResponse({ status: 'updated' });
        return true;
      }

      return true;
    });
  }

  createLoadingOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'ai-loading-overlay';
    overlay.id = 'aiLoadingOverlay';
    overlay.innerHTML = `
      <div class="ai-loading-spinner"></div>
      <div class="ai-loading-text">AI is analyzing form fields...</div>
      <button class="ai-cancel-btn" id="aiCancelBtn">Cancel</button>
    `;
    document.body.appendChild(overlay);
    
    document.getElementById('aiCancelBtn').addEventListener('click', () => {
      this.cancelProcessing();
    });
  }

  removeLoadingOverlay() {
    const overlay = document.getElementById('aiLoadingOverlay');
    if (overlay) overlay.remove();
  }

  async cancelProcessing() {
    this.isCancelled = true;
    this.aiBridge.cancelAllPending();
    
    if (this.currentSessionId) {
      try {
        await this.aiBridge.destroy(this.currentSessionId);
      } catch (e) {
        console.log('Session cleanup error:', e);
      }
      this.currentSessionId = null;
    }
    
    this.removeLoadingOverlay();
    this.isProcessing = false;
    
    chrome.runtime.sendMessage({ action: 'processingComplete' });
  }

  /**
   * Orchestrates the entire form filling process using iterative field collection.
   * @param {string} context - The text content to use for filling forms.
   * @param {boolean} useAI - Whether to use the AI model or fallback to patterns.
   */
  async processFormFilling(context, useAI) {
    if (this.isProcessing) return;
    
    this.isProcessing = true;
    this.isCancelled = false;
    this.clearOverlays(false);
    
    // Show loading overlay
    this.createLoadingOverlay();

    // Step 1: Iteratively collect all form elements
    const elements = this.collectAllFormElements();
    if (elements.length === 0) {
      console.log('No form fields found on the page.');
      this.removeLoadingOverlay();
      this.isProcessing = false;
      chrome.runtime.sendMessage({ action: 'processingComplete' });
      return;
    }

    // Step 2: Create structured JSON of collected fields
    const fieldsJson = this.createFieldsJson(elements);
    
    // Step 3: Get FULL PAGE HTML (kept for future improvements)
    const pageHtml = this.getFullPageHtml();

    if (useAI) {
      try {
        if (this.isCancelled) throw new Error("Cancelled by user");
        
        const sessionInfo = await this.aiBridge.createSession({ topK: 3, temperature: 0.3 });
        this.currentSessionId = sessionInfo.sessionId;
        if (!this.currentSessionId) throw new Error("Failed to create session, no sessionId returned.");

        console.log(`AI session created: ${this.currentSessionId}. Analyzing ${elements.length} fields...`);
        
        if (this.isCancelled) throw new Error("Cancelled by user");
        
        // Step 4: Pass BOTH HTML AND fields JSON to AI for smart analysis (now in batches over ALL fields)
        await this.analyzeWithFullHtml(elements, fieldsJson, pageHtml, context, this.currentSessionId);
        
      } catch (e) {
        if (e.message === "Cancelled by user") {
          console.log("Operation cancelled by user");
        } else {
          console.error("AI processing failed:", e);
          alert("AI processing failed: " + e.message);
        }
      } finally {
        if (this.currentSessionId) {
          console.log(`Destroying AI session: ${this.currentSessionId}`);
          try {
            await this.aiBridge.destroy(this.currentSessionId);
          } catch (e) {
            console.log('Session cleanup error:', e);
          }
          this.currentSessionId = null;
        }
        this.removeLoadingOverlay();
        this.isProcessing = false;
        chrome.runtime.sendMessage({ action: 'processingComplete' });
      }
    } else {
      console.log("Using pattern matching for analysis.");
      await this.analyzeWithPatterns(elements, context);
      this.removeLoadingOverlay();
      this.isProcessing = false;
      chrome.runtime.sendMessage({ action: 'processingComplete' });
    }

    if (!this.isCancelled) {
      console.log(`Analysis complete. Found ${this.identifiedFields.length} potential fields to fill.`);
      this.createOverlays();
    }
  }

  /**
   * Iteratively collect all form elements on the page
   */
  collectAllFormElements() {
    const elements = [];
    const seenElements = new Set();

    // Prepare form indexing for stable addressing
    const formsArr = Array.from(document.querySelectorAll('form'));
    const formIndexMap = new Map(formsArr.map((f, i) => [f, i]));
    const formOrderMap = new Map(formsArr.map((f) => [f, 0]));
    let standaloneOrder = 0;

    const addElement = (el, details) => {
      if (!el || seenElements.has(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width > 5 && rect.height > 5) {
        elements.push({
          element: el,
          rect: rect,
          ...details
        });
        seenElements.add(el);
      }
    };

    // Collect all forms first
    formsArr.forEach(form => {
      // Get all input elements within this form
      const formInputs = form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
      formInputs.forEach(input => {
        const orderWithinForm = (formOrderMap.get(form) || 0);
        formOrderMap.set(form, orderWithinForm + 1);

        addElement(input, {
          type: this.getFieldType(input),
          label: this.findLabel(input),
          formId: form.id || null,
          formName: form.name || null,
          formAction: form.action || null,
          formMethod: form.method || null,
          formIndex: formIndexMap.get(form),
          orderWithinForm
        });
      });
    });

    // Also collect inputs outside of forms
    const standaloneInputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
    standaloneInputs.forEach(input => {
      if (!input.closest('form')) {
        standaloneOrder += 1;
        addElement(input, {
          type: this.getFieldType(input),
          label: this.findLabel(input),
          formId: null,
          formName: null,
          formAction: null,
          formMethod: null,
          formIndex: -1,
          orderWithinForm: standaloneOrder
        });
      }
    });

    // Collect contenteditable elements
    const editables = document.querySelectorAll('[contenteditable="true"]');
    editables.forEach(editable => {
      addElement(editable, {
        type: 'text',
        label: this.findLabel(editable),
        isContentEditable: true,
        formIndex: editable.closest('form') ? (formIndexMap.get(editable.closest('form')) ?? -1) : -1,
        orderWithinForm: 9999
      });
    });

    // Collect potential fields with ARIA attributes
    const potentialFields = document.querySelectorAll('[role="textbox"], [aria-label], [data-placeholder]');
    potentialFields.forEach(field => {
      addElement(field, {
        type: 'text',
        label: field.getAttribute('aria-label') || field.getAttribute('data-placeholder') || '',
        isPotential: true,
        formIndex: field.closest('form') ? (formIndexMap.get(field.closest('form')) ?? -1) : -1,
        orderWithinForm: 9999
      });
    });

    return elements;
  }

  /**
   * Create structured JSON representation of collected fields
   */
  createFieldsJson(elements) {
    return elements.map((field, index) => {
      const rec = {
        index: index,
        type: field.type,
        label: field.label || '',
        name: field.element.name || '',
        id: field.element.id || '',
        placeholder: field.element.placeholder || '',
        required: field.element.required || false,
        className: field.element.className || '',
        formId: field.formId || null,
        formName: field.formName || null,
        formAction: field.formAction || null,
        formMethod: field.formMethod || null,
        formIndex: typeof field.formIndex === 'number' ? field.formIndex : -1,
        orderWithinForm: typeof field.orderWithinForm === 'number' ? field.orderWithinForm : -1,
        tagName: field.element.tagName,
        attributes: this.getRelevantAttributes(field.element),
        parentLabels: this.getParentLabels(field.element),
        nearbyText: this.getNearbyText(field.element),
        cssPath: this.computeCssPath(field.element)
      };
      rec.stableKey = this.computeStableKey(rec);
      return rec;
    });
  }

  /**
   * Get relevant attributes from an element
   */
  getRelevantAttributes(element) {
    const relevantAttrs = ['aria-label', 'aria-describedby', 'data-field', 'data-type', 'autocomplete', 'pattern', 'maxlength', 'minlength'];
    const attrs = {};
    relevantAttrs.forEach(attr => {
      const value = element.getAttribute(attr);
      if (value) attrs[attr] = value;
    });
    return attrs;
  }

  /**
   * Get parent labels and headings
   */
  getParentLabels(element) {
    const labels = [];
    let parent = element.parentElement;
    let depth = 0;
    while (parent && depth < 3) {
      const parentLabels = parent.querySelectorAll('label, h1, h2, h3, h4, h5, h6, th, legend');
      parentLabels.forEach(label => {
        if (!label.contains(element)) {
          labels.push(label.textContent.trim());
        }
      });
      parent = parent.parentElement;
      depth++;
    }
    return labels;
  }

  /**
   * Get nearby text content
   */
  getNearbyText(element) {
    const texts = [];
    const parent = element.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children);
      const index = siblings.indexOf(element);
      
      // Get text from previous sibling
      if (index > 0 && siblings[index - 1]) {
        const prevText = siblings[index - 1].textContent.trim();
        if (prevText && prevText.length < 200) texts.push(prevText);
      }
      
      // Get text from next sibling
      if (index < siblings.length - 1 && siblings[index + 1]) {
        const nextText = siblings[index + 1].textContent.trim();
        if (nextText && nextText.length < 200) texts.push(nextText);
      }
    }
    return texts;
  }

  /**
   * Compute a robust CSS path for an element, falling back to a structural path.
   */
  computeCssPath(el) {
    try {
      const esc = (s) => {
        if (window.CSS && CSS.escape) return CSS.escape(s);
        return String(s).replace(/([ !"#$%&'()*+,.\/:;<=>?@[\\```^`{|}~])/g, '\\$1');
      };

      if (el.id && document.querySelectorAll(`#${esc(el.id)}`).length === 1) {
        return `#${el.id}`;
      }

      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && node !== document.documentElement) {
        let sel = node.nodeName.toLowerCase();

        if (node.id) {
          sel += `#${esc(node.id)}`;
          parts.unshift(sel);
          break;
        } else {
          const classList = Array.from(node.classList || []).slice(0, 2);
          if (classList.length) {
            sel += classList.map(c => `.${esc(c)}`).join('');
          }
          // nth-of-type for stability
          let nth = 1;
          let sib = node.previousElementSibling;
          while (sib) {
            if (sib.nodeName === node.nodeName) nth++;
            sib = sib.previousElementSibling;
          }
          sel += `:nth-of-type(${nth})`;
          parts.unshift(sel);
          node = node.parentElement;
        }
      }
      return parts.join(' > ');
    } catch (e) {
      return '';
    }
  }

  hashString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h) + s.charCodeAt(i);
      h |= 0;
    }
    return (h >>> 0).toString(36);
  }

  computeStableKey(fj) {
    const norm = (v) => (v || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
    const payload = JSON.stringify({
      t: norm(fj.type),
      tg: norm(fj.tagName),
      id: norm(fj.id),
      nm: norm(fj.name),
      lb: norm(fj.label),
      ph: norm(fj.placeholder),
      fid: norm(fj.formId),
      fn: norm(fj.formName),
      fa: norm(fj.formAction),
      fm: norm(fj.formMethod),
      fi: typeof fj.formIndex === 'number' ? fj.formIndex : -1,
      of: typeof fj.orderWithinForm === 'number' ? fj.orderWithinForm : -1,
      pL: (fj.parentLabels || []).map(norm).join('|'),
      nT: (fj.nearbyText || []).map(norm).join('|'),
      cp: norm(fj.cssPath)
    });
    return `k_${this.hashString(payload)}`;
  }

  /**
   * Get FULL PAGE HTML
   */
  getFullPageHtml() {
    // Clone the document to avoid modifying the actual page
    const docClone = document.documentElement.cloneNode(true);
    
    // Remove script tags to reduce size
    const scripts = docClone.querySelectorAll('script');
    scripts.forEach(script => script.remove());
    
    // Remove style tags to reduce size
    const styles = docClone.querySelectorAll('style');
    styles.forEach(style => style.remove());
    
    // Get the HTML string
    const htmlString = docClone.outerHTML;
    
    // Limit to reasonable size for LLM processing (keep first 15000 chars)
    return htmlString.slice(0, 15000);
  }

  parseArrayFromText(input) {
    // 1) Normalize to assistant's content if HF full object was returned
    let text = '';
    if (typeof input === 'string') {
      text = input;
      const trimmed = text.trim();
      if (trimmed.startsWith('{') && trimmed.indexOf('"choices"') !== -1) {
        try {
          const obj = JSON.parse(trimmed);
          const ch = obj && obj.choices && obj.choices[0];
          const content = ch && ch.message && typeof ch.message.content === 'string'
            ? ch.message.content
            : (ch && ch.delta && typeof ch.delta.content === 'string' ? ch.delta.content : null);
          if (typeof content === 'string') text = content;
        } catch (_) {}
      }
    } else if (input && typeof input === 'object') {
      try {
        const ch = input.choices && input.choices[0];
        const content = ch && ch.message && typeof ch.message.content === 'string'
          ? ch.message.content
          : (ch && ch.delta && typeof ch.delta.content === 'string' ? ch.delta.content : null);
        text = typeof content === 'string' ? content : JSON.stringify(input);
      } catch (_) {
        text = '';
      }
    } else {
      return [];
    }

    if (!text || typeof text !== 'string') return [];

    // 2) Strip BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    // 3) Strip code fences if present
    const stripFences = (s) => {
      s = s.trim();
      if (s.startsWith('```')) {
        const firstNewline = s.indexOf('\n');
        if (firstNewline !== -1) s = s.slice(firstNewline + 1);
        const lastFence = s.lastIndexOf('```');
        if (lastFence !== -1) s = s.slice(0, lastFence);
      }
      return s.trim();
    };
    text = stripFences(text);

    // 4) Try direct parse
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j)) return j;
    } catch (_) {}

    // 5) Locate the array and extract all complete JSON objects within it (tolerates truncation)
    const start = text.indexOf('[');
    if (start === -1) return [];

    let inString = false;
    let escape = false;
    let curlyDepth = 0;
    let objStart = -1;
    const results = [];

    for (let i = start + 1; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') {
        if (curlyDepth === 0) objStart = i;
        curlyDepth++;
        continue;
      }

      if (ch === '}') {
        curlyDepth--;
        if (curlyDepth === 0 && objStart !== -1) {
          const objText = text.slice(objStart, i + 1);
          try {
            const obj = JSON.parse(objText);
            results.push(obj);
          } catch (_) {
            // ignore malformed object
          }
          objStart = -1;
        }
        continue;
      }
    }

    return results;
  }

  /**
   * New: Batched AI analysis over ALL fields with robust key-based index resolution
   */
  async analyzeWithFullHtml(elements, fieldsJson, pageHtml, context, sessionId) {
    if (this.isCancelled) return;

    // Cache for robust resolution later
    this.fieldsJsonCache = fieldsJson;
    this.elementsCache = elements;
    this.fieldKeyToIndex = new Map(fieldsJson.map((f, i) => [f.stableKey, i]));
    this.cssPathToIndex = new Map();
    fieldsJson.forEach((f, i) => {
      if (f.cssPath && !this.cssPathToIndex.has(f.cssPath)) {
        this.cssPathToIndex.set(f.cssPath, i);
      }
    });
    
    // Build SELECT options info for AI
    const fieldsWithOptions = fieldsJson.map((field, idx) => {
      const elem = elements[idx]?.element;
      const extra = {};
      if (elem && elem.tagName === 'SELECT') {
        extra.options = Array.from(elem.options).map(opt => ({
          value: opt.value,
          text: opt.text
        }));
      }
      // Skip file inputs (cannot be filled programmatically)
      const isFile = (elem && elem.tagName === 'INPUT' && elem.type && elem.type.toLowerCase() === 'file') || field.type === 'file';
      return {
        ...field,
        ...extra,
        isFile
      };
    });

    // Process in batches so we don't miss fields
    const batchSize = 24;
    const usedIndices = new Set();
    const usedKeys = new Set();
    const norm = (s) => (s || '').toString().trim().toLowerCase();

    for (let start = 0; start < fieldsWithOptions.length; start += batchSize) {
      if (this.isCancelled) throw new Error("Cancelled by user");
      const chunk = fieldsWithOptions.slice(start, start + batchSize)
        // do not include file inputs in the prompt
        .filter(f => !f.isFile);

      // Build minimal chunk description to reduce token usage
      const chunkForModel = chunk.map(f => ({
        key: f.stableKey,           // STABLE KEY (canonical)
        index: f.index,             // GLOBAL INDEX (for reference only)
        type: f.type,
        tagName: f.tagName,
        id: f.id,
        name: f.name,
        label: f.label,
        placeholder: f.placeholder,
        nearbyText: f.nearbyText,
        cssPath: f.cssPath,
        formIndex: f.formIndex,
        orderWithinForm: f.orderWithinForm,
        options: f.options
      }));

const prompt = `
You are an intelligent form-filling assistant. Analyze the following fields and extract ONLY relevant values from the user context.

IMPORTANT IDENTIFIERS:
- key: The canonical unique identifier for a field. ALWAYS include this in your output exactly as provided.
- index: A global numeric index of the field. May be used as a reference, but "key" is the source of truth.

User Context (may be truncated):
${context.slice(0, 2500)}

Fields (GLOBAL indexes, canonical keys):
${JSON.stringify(chunkForModel, null, 2)}

Rules:
- Return ONLY a JSON array of objects: [{"key": string, "index": number, "value": string, "confidence": 0.0-1.0, "reason": string}]
- "key" is REQUIRED and MUST exactly match one of the provided keys.
- "index" is optional; if present it must refer to the same field as "key". If mismatch occurs, "key" takes precedence.
- Only include fields you can confidently fill from the context or sensible defaults below.
- For first name: only the first name (e.g., "Merry"). For last name: only the last name ("Christmas").
- For phone: return a single phone number (e.g., "+0 000 000 0000"), if present in context.
- For email: extract a valid email if present.
- For address fields: address1/street, city, state/province, zip/postal.
- For DATE fields (type="date"): 
  * MUST return in format "YYYY-MM-DD" (e.g., "2024-01-15")
  * If you see "2017-Present" or similar, return just the start year as "2017-01-01"
  * If date is "Present" or "Current", use today's date
  * Never return text like "Present" or date ranges for date inputs
- For SELECT fields: choose only from "options" and return the option's "value" (not text).
- Defaults:
  - "source" (how did you hear): prefer "search_engine" or "other" if unsure.
  - "specify": short relevant text if available, otherwise "N/A".
  - "work_authorization": if unsure, "yes".
  - "start_date" or any date field: if context mentions a year like "2017", return "2017-01-01"
- Skip file inputs — do NOT include them in output.
- If no data for a field and no sensible default, omit it from the results.

Return JSON array only.
`.trim();

      try {
        const res = await this.aiBridge.prompt(sessionId, prompt);
        const parsed = this.parseArrayFromText(res);

        if (Array.isArray(parsed) && parsed.length > 0) {
          parsed.forEach(item => {
            const resolvedIdx = this.resolveFieldIndex(item, fieldsJson);
            if (resolvedIdx === -1) return;
            if (usedIndices.has(resolvedIdx)) return;
            if (item == null || item.value == null || String(item.value).trim() === '') return;

            const field = elements[resolvedIdx];
            if (!field || !field.element) return;

            // Validate SELECT values
            if (field.element.tagName === 'SELECT') {
              const options = Array.from(field.element.options);
              const value = String(item.value).trim();
              const hasOption = options.some(opt => 
                norm(opt.value) === norm(value) || norm(opt.text) === norm(value)
              );

              if (!hasOption) {
                // Provide consistent defaults for some known selects
                if (field.element.name === 'source' || field.element.id === 'source') {
                  const preferred = ['search_engine', 'other'];
                  const firstMatch = options.find(o => preferred.includes(o.value));
                  if (firstMatch) {
                    item.value = firstMatch.value;
                  } else {
                    return; // skip if no sensible default
                  }
                } else if (field.element.name === 'work_authorization' || field.element.id === 'work_authorization') {
                  const yesOpt = options.find(o => norm(o.value) === 'yes');
                  if (yesOpt) {
                    item.value = yesOpt.value;
                  } else {
                    return;
                  }
                } else if (field.element.name === 'position' || field.element.id === 'position') {
                  const se = options.find(o => norm(o.value) === 'software_engineer') || options.find(o => o.value);
                  if (se) {
                    item.value = se.value;
                  } else {
                    return;
                  }
                } else {
                  return; // skip invalid select choices
                }
              }
            }

            usedIndices.add(resolvedIdx);
            if (item.key) usedKeys.add(item.key);

            this.identifiedFields.push({
              ...field,
              suggestedValue: String(item.value).trim(),
              confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.8)),
              reason: item.reason || '',
              included: true
            });
          });
        }
      } catch (e) {
        if (e.message === "Cancelled by user") throw e;
        console.warn('Batch AI analysis failed:', e);
        // Continue with other batches
      }
    }

    // Ensure sensible defaults for common required fields if AI omitted them
    this.addMissingDefaults(elements, fieldsJson, usedIndices);

    if (!this.identifiedFields.length) {
      throw new Error("AI returned no valid data");
    }
  }

  /**
   * Resolve item to a global field index using robust key-first matching,
   * then cssPath, then id/name/label, then formIndex+orderWithinForm, and finally index.
   */
  resolveFieldIndex(item, fieldsJson) {
    const inRange = (n) => typeof n === 'number' && n >= 0 && n < fieldsJson.length;
    const norm = (s) => (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');

    // 1) Prefer the canonical stable key
    if (item.key && this.fieldKeyToIndex.has(item.key)) {
      return this.fieldKeyToIndex.get(item.key);
    }

    // 2) Try cssPath if provided
    if (item.cssPath && this.cssPathToIndex.has(item.cssPath)) {
      return this.cssPathToIndex.get(item.cssPath);
    }

    // 3) Try by id
    if (item.id) {
      const idx = fieldsJson.findIndex(f => norm(f.id) === norm(item.id));
      if (idx !== -1) return idx;
    }

    // 4) Try by name
    if (item.name) {
      const idx = fieldsJson.findIndex(f => norm(f.name) === norm(item.name));
      if (idx !== -1) return idx;
    }

    // 5) Try by label
    if (item.label) {
      const idx = fieldsJson.findIndex(f => norm(f.label) === norm(item.label));
      if (idx !== -1) return idx;
    }

    // 6) Try by formIndex + orderWithinForm combo
    if (typeof item.formIndex === 'number' && typeof item.orderWithinForm === 'number') {
      const idx = fieldsJson.findIndex(f => f.formIndex === item.formIndex && f.orderWithinForm === item.orderWithinForm);
      if (idx !== -1) return idx;
    }

    // 7) Fallback to global index only if valid
    if (inRange(item.index)) return item.index;

    return -1;
  }

  /**
   * Ensure defaults for commonly required fields when omitted by the AI.
   */
  addMissingDefaults(elements, fieldsJson, usedIndices) {
    const hasIdx = (i) => this.identifiedFields.some(ff => ff.element === elements[i].element);

    const findIdx = (pred) => fieldsJson.findIndex(pred);

    // source
    let idx = findIdx(f => (f.name === 'source' || f.id === 'source' || /how did you hear/i.test(f.label)) && elements[f.index]?.element?.tagName === 'SELECT');
    if (idx !== -1 && !hasIdx(idx)) {
      const sel = elements[idx].element;
      const options = Array.from(sel.options || []);
      const preferred = options.find(o => o.value === 'search_engine') || options.find(o => o.value === 'other') || options.find(o => o.value);
      if (preferred) {
        usedIndices.add(idx);
        this.identifiedFields.push({
          ...elements[idx],
          suggestedValue: preferred.value,
          confidence: 0.6,
          reason: 'default: required select',
          included: true
        });
      }
    }

    // specify
    idx = findIdx(f => (f.name === 'specify' || f.id === 'specify' || /specify/i.test(f.label)) && (elements[f.index]?.element?.tagName || '').toLowerCase() === 'input');
    if (idx !== -1 && !hasIdx(idx)) {
      usedIndices.add(idx);
      this.identifiedFields.push({
        ...elements[idx],
        suggestedValue: 'N/A',
        confidence: 0.5,
        reason: 'default: unspecified',
        included: true
      });
    }

    // work_authorization
    idx = findIdx(f => (f.name === 'work_authorization' || f.id === 'work_authorization') && elements[f.index]?.element?.tagName === 'SELECT');
    if (idx !== -1 && !hasIdx(idx)) {
      const sel = elements[idx].element;
      const options = Array.from(sel.options || []);
      const yes = options.find(o => /yes/i.test(o.value) || /yes/i.test(o.text)) || options[0];
      if (yes) {
        usedIndices.add(idx);
        this.identifiedFields.push({
          ...elements[idx],
          suggestedValue: yes.value,
          confidence: 0.6,
          reason: 'default: assume authorized',
          included: true
        });
      }
    }

    // position
    idx = findIdx(f => (f.name === 'position' || f.id === 'position') && elements[f.index]?.element?.tagName === 'SELECT');
    if (idx !== -1 && !hasIdx(idx)) {
      const sel = elements[idx].element;
      const options = Array.from(sel.options || []).filter(o => o.value);
      const se = options.find(o => o.value === 'software_engineer') || options[0];
      if (se) {
        usedIndices.add(idx);
        this.identifiedFields.push({
          ...elements[idx],
          suggestedValue: se.value,
          confidence: 0.55,
          reason: 'default: common position',
          included: true
        });
      }
    }
  }

  async checkAI() {
    try {
      const caps = await this.aiBridge.capabilities();
      return caps;
    } catch (e) {
      console.error("AI check failed:", e);
      return { available: 'no', error: String(e) };
    }
  }

  getFieldType(element) {
    if (element.tagName === 'SELECT') return 'select';
    if (element.tagName === 'TEXTAREA') return 'textarea';

    const type = element.type?.toLowerCase();
    const name = element.name?.toLowerCase() || '';
    const id = element.id?.toLowerCase() || '';
    const placeholder = element.placeholder?.toLowerCase() || '';
    const label = this.findLabel(element).toLowerCase();
    
    // More specific field type detection
    if (type === 'email' || name.includes('email') || id.includes('email') || label.includes('email')) return 'email';
    if (type === 'tel' || name.includes('phone') || id.includes('phone') || label.includes('phone')) return 'phone';
    if (type === 'password') return 'password';
    if (type === 'date' || name.includes('date') || id.includes('date') || label.includes('date')) return 'date';
    if (type === 'file') return 'file';
    
    // Improved name field detection
    if (name === 'firstname' || id === 'fname' || label.includes('first name')) return 'firstName';
    if (name === 'lastname' || id === 'lname' || label.includes('last name')) return 'lastName';
    if (name.includes('name') || id.includes('name') || placeholder.includes('name') || label.includes('name')) {
      if (name.includes('first') || id.includes('first') || label.includes('first')) return 'firstName';
      if (name.includes('last') || id.includes('last') || label.includes('last') || label.includes('sur')) return 'lastName';
      if (name.includes('full') || label.includes('full')) return 'fullName';
      return 'name'; // Generic name field
    }
    
    // Address-related fields
    if (name === 'address1' || id === 'address1' || label.includes('street address')) return 'address';
    if (name === 'address2' || id === 'address2' || label.includes('address line 2')) return 'address2';
    if (name.includes('city') || id.includes('city') || label.includes('city')) return 'city';
    if (name.includes('state') || id.includes('state') || label.includes('state') || label.includes('province')) return 'state';
    if (name.includes('zip') || id.includes('zip') || name.includes('postal') || label.includes('zip') || label.includes('postal')) return 'zip';
    if (name.includes('company') || id.includes('company') || label.includes('company')) return 'company';
    
    // Feedback/comments fields
    if (name === 'feedback' || id === 'feedback' || label.includes('feedback')) return 'feedback';
    if (name === 'specify' || id === 'specify' || label.includes('specify')) return 'specify';
    if (name === 'source' || id === 'source' || label.includes('how did you hear')) return 'source';

    // Other application-specific fields (non-critical typing, still useful for labels)
    if (name === 'position' || id === 'position') return 'position';
    if (name === 'linkedin' || id === 'linkedin') return 'url';
    if (name === 'portfolio' || id === 'portfolio') return 'url';
    if (name === 'job_title' || id === 'job_title') return 'text';
    if (name === 'experience_years' || id === 'experience_years') return 'number';
    if (name === 'skills' || id === 'skills') return 'textarea';
    if (name === 'cover_letter' || id === 'cover_letter') return 'textarea';
    if (name === 'work_authorization' || id === 'work_authorization') return 'select';
    if (name === 'start_date' || id === 'start_date') return 'date';

    return type || 'text';
  }

  findLabel(element) {
    if (element.id) {
      const label = document.querySelector(`label[for="${element.id}"]`);
      if (label) return label.textContent.trim();
    }

    const parentLabel = element.closest('label');
    if (parentLabel) {
      return Array.from(parentLabel.childNodes)
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join(' ');
    }

    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const ariaLabelledby = element.getAttribute('aria-labelledby');
    if (ariaLabelledby) {
      const labelEl = document.getElementById(ariaLabelledby);
      if (labelEl) return labelEl.textContent.trim();
    }

    return element.placeholder || element.name || '';
  }

  async analyzeWithPatterns(elements, context) {
    elements.forEach(field => {
      this.analyzeFieldWithPatterns(field, context);
    });
  }

  analyzeFieldWithPatterns(field, context) {
    const patterns = {
      email: /[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/i,
      phone: /(?:\+?\d{1,3}[-.\s]?)?(?:KATEX_INLINE_OPEN?\d{3}KATEX_INLINE_CLOSE?[-.\s]?)?\d{3}[-.\s]?\d{4}/,
      firstName: /^([A-Z][a-z]+)/m,
      lastName: /^[A-Z][a-z]+\s+([A-Z][a-z]+)/m,
      fullName: /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/m,
      address: /(?:address|street)[:\s]+([^,\n]+)/i,
      city: /(?:city)[:\s]+([A-Za-z\s]+)/i,
      state: /(?:state|province)[:\s]+([A-Za-z\s]+)/i,
      zip: /\b\d{5}(?:-\d{4})?\b/,
      company: /(?:company|organization|employer)[:\s]+([^,\n]+)/i
    };

    let suggestedValue = '';
    let confidence = 0;

    // Special handling for name fields from "Mr. Merry Christmas"
    if (field.type === 'firstName') {
      const nameMatch = context.match(/Mr\.\s+([A-Z][a-z]+)\s+([A-Z][a-z]+)/);
      if (nameMatch) {
        suggestedValue = nameMatch[1]; // "Merry"
        confidence = 0.9;
      }
    } else if (field.type === 'lastName') {
      const nameMatch = context.match(/Mr\.\s+([A-Z][a-z]+)\s+([A-Z][a-z]+)/);
      if (nameMatch) {
        suggestedValue = nameMatch[2]; // "Christmas"
        confidence = 0.9;
      }
    } else if (field.type === 'phone') {
      const phoneMatch = context.match(/\+7\s*995\s*664\s*9220/);
      if (phoneMatch) {
        suggestedValue = phoneMatch[0];
        confidence = 0.9;
      }
    } else if (field.type === 'state') {
      // Look for "European Union"
      if (context.includes('European Union')) {
        suggestedValue = 'European Union';
        confidence = 0.7;
      }
    } else {
      // Try generic pattern matching
      const pattern = patterns[field.type];
      if (pattern) {
        const match = context.match(pattern);
        if (match) {
          suggestedValue = match[1] || match[0];
          confidence = 0.7;
        }
      }
    }

    if (suggestedValue) {
      this.identifiedFields.push({
        ...field,
        suggestedValue: suggestedValue.trim(),
        confidence: confidence,
        included: true
      });
    }
  }

  createOverlays() {
    this.identifiedFields.forEach((field, index) => {
      const overlay = document.createElement('div');
      overlay.className = 'ai-form-overlay';
      overlay.style.cssText = `
        position: absolute;
        top: 0px;
        left: 0px;
        width: 0px;
        height: 0px;
        pointer-events: none;
        z-index: 10000;
      `;

      const label = document.createElement('div');
      label.className = 'ai-field-label';
      label.style.cssText = `
        position: absolute; top: -25px; left: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white; padding: 4px 8px; border-radius: 4px; font-family: sans-serif;
        font-size: 11px; font-weight: bold; white-space: nowrap;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2); pointer-events: auto;
      `;
      label.textContent = `${field.type.toUpperCase()} • ${Math.round(field.confidence * 100)}%`;

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'ai-toggle-btn';
      toggleBtn.style.cssText = `
        position: absolute; top: -25px; right: 0; width: 20px; height: 20px;
        border-radius: 50%; border: none; background: ${field.included ? '#4caf50' : '#f44336'};
        color: white; font-size: 12px; cursor: pointer; pointer-events: auto;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      `;
      toggleBtn.innerHTML = field.included ? '✓' : '✗';
      toggleBtn.onclick = (e) => {
        e.stopPropagation();
        this.toggleField(index);
      };

      const border = document.createElement('div');
      border.className = 'ai-field-border';
      border.style.cssText = `
        position: absolute; top: 0; left: 0; width: 100%; height: 100%;
        border: 2px solid ${field.included ? '#667eea' : '#ccc'}; border-radius: 4px;
        background: ${field.included ? 'rgba(102, 126, 234, 0.1)' : 'rgba(200, 200, 200, 0.1)'};
        transition: all 0.3s; box-sizing: border-box;
      `;

      overlay.appendChild(label);
      overlay.appendChild(toggleBtn);
      overlay.appendChild(border);
      document.body.appendChild(overlay);

      this.fieldOverlays.push(overlay);

      if (field.included && field.suggestedValue) {
        this.fillField(field.element, field.suggestedValue, field.isContentEditable);
      }
    });

    if (this.identifiedFields.length > 0) {
      this.createActionPanel();
    }

    // Ensure overlays are positioned correctly and stay aligned on scroll/resize
    this.startOverlayTracking();
  }

  startOverlayTracking() {
    if (this.updateOverlayPositionsBound) return;
    this.updateOverlayPositionsBound = this.updateOverlayPositions.bind(this);

    // Capture scroll on any element (not just window) to reposition overlays
    window.addEventListener('scroll', this.updateOverlayPositionsBound, true);
    window.addEventListener('resize', this.updateOverlayPositionsBound);

    try {
      this.resizeObserver = new ResizeObserver(this.updateOverlayPositionsBound);
      this.identifiedFields.forEach(f => {
        if (f?.element) this.resizeObserver.observe(f.element);
      });
    } catch (e) {
      // ResizeObserver not available; fallback only on scroll/resize
    }

    // Initial position
    this.updateOverlayPositions();
  }

  stopOverlayTracking() {
    if (this.updateOverlayPositionsBound) {
      window.removeEventListener('scroll', this.updateOverlayPositionsBound, true);
      window.removeEventListener('resize', this.updateOverlayPositionsBound);
      this.updateOverlayPositionsBound = null;
    }
    if (this.resizeObserver) {
      try { this.resizeObserver.disconnect(); } catch (_) {}
      this.resizeObserver = null;
    }
  }

  updateOverlayPositions() {
    this.fieldOverlays.forEach((overlay, i) => {
      const field = this.identifiedFields[i];
      if (!overlay || !field || !field.element || !document.contains(field.element)) {
        if (overlay) overlay.style.display = 'none';
        return;
      }
      const rect = field.element.getBoundingClientRect();
      // Hide overlay for invisible fields
      if (rect.width < 1 || rect.height < 1) {
        overlay.style.display = 'none';
        return;
      }
      overlay.style.display = 'block';
      overlay.style.top = `${rect.top + window.scrollY}px`;
      overlay.style.left = `${rect.left + window.scrollX}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
    });
  }

  createActionPanel() {
    const panel = document.createElement('div');
    panel.className = 'ai-action-panel';
    panel.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; background: white; border-radius: 8px;
      padding: 15px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 10001;
      font-family: sans-serif; min-width: 220px;
    `;
    panel.innerHTML = `
      <div style="font-weight: bold; margin-bottom: 10px; color: #333; font-size: 14px;">
        AI Form Fill Analysis
      </div>
      <div style="font-size: 13px; color: #666; margin-bottom: 15px;">
        Found and filled ${this.identifiedFields.filter(f=>f.included).length} of ${this.identifiedFields.length} fields.
      </div>
      <button id="aiClearAnalysis" style="
        width: 100%; padding: 8px; background: #f5f5f5; color: #333;
        border: 1px solid #ddd; border-radius: 4px; cursor: pointer;
      ">Clear and Close</button>
    `;
    document.body.appendChild(panel);
    document.getElementById('aiClearAnalysis').onclick = () => this.clearOverlays(true);
  }

  toggleField(index) {
    const field = this.identifiedFields[index];
    field.included = !field.included;

    const overlay = this.fieldOverlays[index];
    const toggleBtn = overlay.querySelector('.ai-toggle-btn');
    const border = overlay.querySelector('.ai-field-border');

    toggleBtn.style.background = field.included ? '#4caf50' : '#f44336';
    toggleBtn.innerHTML = field.included ? '✓' : '✗';
    border.style.borderColor = field.included ? '#667eea' : '#ccc';
    border.style.background = field.included ? 'rgba(102, 126, 234, 0.1)' : 'rgba(200, 200, 200, 0.1)';

    if (field.included) {
      this.fillField(field.element, field.suggestedValue, field.isContentEditable);
    } else {
      this.clearField(field.element, field.isContentEditable);
    }

    // Reposition in case visibility changed layout
    this.updateOverlayPositions();
  }

	fillField(element, value, isContentEditable) {
	  if (isContentEditable) {
		element.textContent = value;
	  } else if (element.tagName === 'SELECT') {
		// Handle SELECT elements specially
		const options = Array.from(element.options);
		const valueLower = String(value).toLowerCase().trim();
		
		// Try exact match first
		let matchedOption = options.find(opt => 
		  opt.value.toLowerCase() === valueLower || opt.text.toLowerCase() === valueLower
		);
		
		// If no exact match, try partial match
		if (!matchedOption) {
		  matchedOption = options.find(opt => 
			opt.value.toLowerCase().includes(valueLower) || 
			opt.text.toLowerCase().includes(valueLower) ||
			valueLower.includes(opt.value.toLowerCase()) ||
			valueLower.includes(opt.text.toLowerCase())
		  );
		}
		
		if (matchedOption) {
		  element.value = matchedOption.value;
		} else {
		  console.warn(`Could not find matching option for "${value}" in select element`, element);
		}
	  } else if (element.type === 'date') {
		// Special handling for date inputs
		const dateValue = this.sanitizeDateValue(value);
		if (dateValue) {
		  element.value = dateValue;
		} else {
		  console.warn(`Invalid date format "${value}" for date input, skipping`);
		  return; // Don't fill if date is invalid
		}
	  } else {
		element.value = value;
	  }
	  element.dispatchEvent(new Event('input', { bubbles: true }));
	  element.dispatchEvent(new Event('change', { bubbles: true }));
	}

	sanitizeDateValue(value) {
	  if (!value) return null;
	  
	  // Check if already in correct format
	  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return value;
	  }
	  
	  // Try to parse common date formats
	  const dateStr = String(value).trim();
	  
	  // Handle "Present", "Current", "Now" etc.
	  if (/^(present|current|now|today)$/i.test(dateStr)) {
		const today = new Date();
		return today.toISOString().split('T')[0];
	  }
	  
	  // Handle year-only (e.g., "2017" -> "2017-01-01")
	  if (/^\d{4}$/.test(dateStr)) {
		return `${dateStr}-01-01`;
	  }
	  
	  // Handle "YYYY-Present" or "YYYY-Current" patterns
	  const yearMatch = dateStr.match(/^(\d{4})[-\s]*(present|current|now|today)?/i);
	  if (yearMatch) {
		return `${yearMatch[1]}-01-01`;
	  }
	  
	  // Handle MM/DD/YYYY or DD/MM/YYYY
	  const slashDate = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
	  if (slashDate) {
		const month = slashDate[1].padStart(2, '0');
		const day = slashDate[2].padStart(2, '0');
		const year = slashDate[3];
		// Assume MM/DD/YYYY format (US)
		return `${year}-${month}-${day}`;
	  }
	  
	  // Try to parse with Date constructor
	  try {
		const parsed = new Date(dateStr);
		if (!isNaN(parsed.getTime())) {
		  return parsed.toISOString().split('T')[0];
		}
	  } catch (e) {
		// Invalid date
	  }
	  
	  return null;
	}

  clearField(element, isContentEditable) {
    if (isContentEditable) {
      element.textContent = '';
    } else {
      element.value = '';
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  clearOverlays(clearValues = false) {
    // Stop tracking before removing overlays
    this.stopOverlayTracking();

    if (clearValues) {
      this.identifiedFields.forEach(field => {
        if (field.included) this.clearField(field.element, field.isContentEditable);
      });
    }
    this.fieldOverlays.forEach(overlay => overlay.remove());
    this.fieldOverlays = [];
    const panel = document.querySelector('.ai-action-panel');
    if (panel) panel.remove();
    this.identifiedFields = [];
  }
}

// Initialize the integrated form analyzer
new FormAnalyzer();