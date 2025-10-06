(() => {
  const TAG = 'AI_FORM_FILLER_BRIDGE';
  const sessions = new Map();
  let sidCounter = 0;
  
  // Hardcoded HuggingFace token
  const HF_TOKEN = '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';

  function reply(id, payload, error) {
    window.postMessage({ source: TAG, id, payload, error }, '*');
  }

  async function callHuggingFaceAPI(prompt, model = 'meta-llama/Llama-3.2-3B-Instruct:novita') {
    try {
      const data = {
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        model: model,
        max_tokens: 1000,
        temperature: 0.3
      };

      const response = await fetch(
        "https://router.huggingface.co/v1/chat/completions",
        {
          headers: {
            Authorization: `Bearer ${HF_TOKEN}`,
            "Content-Type": "application/json",
          },
          method: "POST",
          body: JSON.stringify(data),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('HF API Error:', errorText);
        throw new Error(`HuggingFace API error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      console.log('HF API Response:', result);
      
      // Extract the actual message content from the chat completion response
      if (result.choices && result.choices[0] && result.choices[0].message) {
        return result.choices[0].message.content;
      }
      
      // Fallback to returning the full result if structure is unexpected
      return JSON.stringify(result);
    } catch (e) {
      console.error('HuggingFace API call failed:', e);
      throw new Error(`HuggingFace API call failed: ${e.message}`);
    }
  }

  window.addEventListener('message', async (event) => {
    const msg = event.data;
    if (!msg || msg.target !== TAG || !msg.type) return;
    const { id, type, data, hfModel } = msg;

    try {
      // Always use HuggingFace if token is available
      const useHuggingFace = HF_TOKEN && HF_TOKEN.length > 0;

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
          text = await callHuggingFaceAPI(prompt, sessionData.model);
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