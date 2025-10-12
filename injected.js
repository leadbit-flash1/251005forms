(() => {
  const TAG = 'AI_FORM_FILLER_BRIDGE';
  const sessions = new Map();
  let sidCounter = 0;
  let hfCallCounter = 0;
  const hfPending = new Map();
  
  // Hardcoded HuggingFace token (fallback)
  const FALLBACK_HF_TOKEN = 'hf'+'_'+'iFRcXDmvbdNFKUwvIKIamRRjWkpdXnxxhY';

  function reply(id, payload, error) {
    window.postMessage({ source: TAG, id, payload, error }, '*');
  }

  // Route HuggingFace API calls through content script -> background
  async function callHuggingFaceAPI(prompt, model = 'meta-llama/Llama-3.2-3B-Instruct:novita', userToken = null) {
    const token = userToken || FALLBACK_HF_TOKEN;
    const callId = `hf_${++hfCallCounter}`;
    
    return new Promise((resolve, reject) => {
      hfPending.set(callId, { resolve, reject });
      
      // Send request to content script
      window.postMessage({
        source: TAG,
        type: 'HF_API_CALL',
        id: callId,
        prompt: prompt,
        model: model,
        token: token
      }, '*');
      
      // Timeout after 30 seconds
      setTimeout(() => {
        if (hfPending.has(callId)) {
          hfPending.delete(callId);
          reject(new Error('HuggingFace API call timeout'));
        }
      }, 30000);
    });
  }

  // Listen for HuggingFace API responses
  window.addEventListener('message', (event) => {
    if (event.data && event.data.source === 'AI_FORM_FILLER_BRIDGE_RESPONSE') {
      const { id, result, error } = event.data;
      const pending = hfPending.get(id);
      if (pending) {
        hfPending.delete(id);
        if (error) {
          pending.reject(new Error(error));
        } else {
          pending.resolve(result);
        }
      }
    }
  });

  window.addEventListener('message', async (event) => {
    const msg = event.data;
    if (!msg || msg.target !== TAG || !msg.type) return;
    const { id, type, data, hfToken, hfModel } = msg;

    try {
      // Use provided token if available, otherwise fallback
      const tokenToUse = hfToken || FALLBACK_HF_TOKEN;
      const useHuggingFace = tokenToUse && tokenToUse.length > 0;

      if (type === 'CAPABILITIES') {
        if (useHuggingFace) {
          return reply(id, { 
            available: 'readily', 
            model: `HuggingFace/${hfModel || 'meta-llama/Llama-3.2-3B-Instruct:novita'}` 
          });
        } else if (window.ai && window.ai.languageModel) {
          const caps = await window.ai.languageModel.capabilities();
          return reply(id, { available: caps.available, model: caps });
        } else {
          return reply(id, { available: 'no' });
        }
      }

      if (type === 'CREATE_SESSION') {
        const sessionId = `s${++sidCounter}`;
        
        if (useHuggingFace) {
          sessions.set(sessionId, {
            type: 'huggingface',
            model: hfModel || 'meta-llama/Llama-3.2-3B-Instruct:novita',
            token: tokenToUse,
            options: data?.options || {}
          });
        } else if (window.ai && window.ai.languageModel) {
          const session = await window.ai.languageModel.create(data?.options || {});
          sessions.set(sessionId, {
            type: 'chrome',
            session: session
          });
        } else {
          throw new Error('No AI backend available');
        }
        
        return reply(id, { sessionId });
      }

      if (type === 'PROMPT') {
        const { sessionId, prompt } = data || {};
        const sessionData = sessions.get(sessionId);
        if (!sessionData) throw new Error('Session not found');

        let text;
        if (sessionData.type === 'huggingface') {
          text = await callHuggingFaceAPI(prompt, sessionData.model, sessionData.token);
        } else if (sessionData.type === 'chrome') {
          text = await sessionData.session.prompt(prompt);
        } else {
          throw new Error('Unknown session type');
        }

        return reply(id, text);
      }

      if (type === 'DESTROY') {
        const { sessionId } = data || {};
        const sessionData = sessions.get(sessionId);
        
        if (sessionData?.type === 'chrome' && sessionData.session?.destroy) {
          sessionData.session.destroy();
        }
        
        sessions.delete(sessionId);
        return reply(id, { ok: true });
      }
    } catch (e) {
      console.error('Bridge error:', e);
      reply(id, null, String(e));
    }
  });
})();