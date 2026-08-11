export function generateModelSummaryMarkup(icon) {
  return `
    <button class="h3ps-active-model" type="button" title="Open model settings" data-open-settings>
      <span class="h3ps-active-model-icon" data-active-model-icon>G</span>
      <span><small data-active-model-source>Prompt model</small><strong data-active-model-name>Scanning models…</strong></span>
      <em data-active-runtime-summary>Runtime · Auto</em>
      ${icon("chevron", 14)}
    </button>`;
}

function systemPromptPanel(profile, description, icon, hidden = false) {
  return `
    <div class="h3ps-system-prompt-panel" data-system-prompt-panel="${profile}" ${hidden ? "hidden" : ""}>
      <span class="h3ps-system-prompt-panel-status"><em data-system-prompt-status="${profile}">Default</em>${icon("check", 13)}</span>
      <p>${description} Official MiniMax guides are applied separately and are not modified.</p>
      <textarea data-system-prompt="${profile}" maxlength="8000" spellcheck="true" disabled></textarea>
      <footer><small data-system-prompt-count="${profile}">0 / 8,000</small><button type="button" data-system-prompt-reset="${profile}" hidden>Reset to default</button></footer>
    </div>`;
}

export function settingsMarkup(icon) {
  return `
    <section class="h3ps-settings-view" data-settings-view hidden>
      <header class="h3ps-settings-heading">
        <span><small>H3 Prompt Writer</small><strong>Settings</strong><em>Inference, runtime and prompt behavior</em></span>
        <button class="h3ps-secondary-button" type="button" data-close-settings>${icon("chevron", 14)} Back to Generate</button>
      </header>

      <div class="h3ps-settings-content">
        <section class="h3ps-settings-card h3ps-provider-settings">
          <header><span><small>Inference</small><strong>Provider</strong></span></header>
          <div class="h3ps-provider-selector" role="tablist" aria-label="Inference provider">
            <button type="button" role="tab" data-provider-option="direct" aria-selected="true">
              <span class="h3ps-provider-icon">G</span><span><strong>Direct GGUF</strong><small>Models installed in ComfyUI</small></span>${icon("check", 14)}
            </button>
            <button type="button" role="tab" data-provider-option="external" aria-selected="false">
              <span class="h3ps-provider-icon">S</span><span><strong>External llama.cpp</strong><small>Existing local llama-server</small></span>${icon("check", 14)}
            </button>
            <button type="button" role="tab" data-provider-option="ollama" aria-selected="false">
              <span class="h3ps-provider-icon">O</span><span><strong>Ollama</strong><small>Simple local model service</small></span>${icon("check", 14)}
            </button>
          </div>
        </section>

        <section class="h3ps-settings-card h3ps-provider-detail" data-provider-detail>
          <div class="h3ps-provider-panel" data-provider-panel="direct">
            <header class="h3ps-settings-section-heading">
              <span><small>Model</small><strong>Installed model</strong></span>
              <button type="button" data-model-refresh>${icon("refresh", 13)} Refresh</button>
            </header>
            <div class="h3ps-installed-model-control">
              <span class="h3ps-model-icon">G</span>
              <label><span>Model used for Direct GGUF</span><select data-installed-model aria-label="Installed model"><option>Scanning models…</option></select></label>
              <span class="h3ps-model-lifecycle" data-model-lifecycle hidden><em data-model-lifecycle-label>Model loaded</em></span>
            </div>
            <p class="h3ps-installed-model-source" data-model-source-label>Local GGUF · llama-cpp-python</p>
            <div data-direct-model-status></div>
            <div class="h3ps-model-utilities">
              <div data-model-scan-slot></div>
              <div data-verified-models-slot></div>
            </div>
          </div>

          <div class="h3ps-provider-panel" data-provider-panel="external" hidden>
            <header class="h3ps-settings-section-heading"><span><small>Connection</small><strong>External llama.cpp server</strong></span></header>
            <div data-external-provider-control></div>
          </div>

          <div class="h3ps-provider-panel" data-provider-panel="ollama" hidden>
            <div data-ollama-provider-control></div>
          </div>

        </section>

        <section class="h3ps-settings-card h3ps-runtime-settings">
          <header><span><small>Runtime</small><strong>Context and KV cache</strong></span><em data-runtime-summary>Auto</em></header>
          <div class="h3ps-runtime-settings-grid">
            <label><span>Context</span><button type="button" data-runtime-toggle="context"><b data-runtime-label="context">Auto</b>${icon("chevron", 12)}</button><span class="h3ps-runtime-menu" data-runtime-menu="context" hidden><button type="button" data-runtime-option="context" data-value="auto">Auto</button><button type="button" data-runtime-option="context" data-value="low">8K</button><button type="button" data-runtime-option="context" data-value="standard">16K</button><button type="button" data-runtime-option="context" data-value="extended">24K</button></span></label>
            <label><span>KV cache</span><button type="button" data-runtime-toggle="kv"><b data-runtime-label="kv">Auto</b>${icon("chevron", 12)}</button><span class="h3ps-runtime-menu" data-runtime-menu="kv" hidden><button type="button" data-runtime-option="kv" data-value="auto">Auto</button><button type="button" data-runtime-option="kv" data-value="q8">Q8</button><button type="button" data-runtime-option="kv" data-value="f16">F16</button></span></label>
          </div>
          <p data-runtime-management>Direct GGUF runtime settings are applied to the next request.</p>
        </section>

        <section class="h3ps-settings-card h3ps-system-prompt-card">
          <header><span><small>Generation behavior</small><strong>System Prompt</strong></span></header>
          <div class="h3ps-system-prompt-profiles" role="tablist" aria-label="System Prompt profile">
            <button type="button" role="tab" data-system-prompt-profile="standard" aria-selected="true">Standard<small>T2VA · I2VA · FL2VA · L2VA</small></button>
            <button type="button" role="tab" data-system-prompt-profile="reference" aria-selected="false">Reference<small>Reference mode</small></button>
          </div>
          ${systemPromptPanel("standard", "Instructions used by T2VA, I2VA, FL2VA and L2VA.", icon)}
          ${systemPromptPanel("reference", "Instructions used by Reference mode.", icon, true)}
        </section>
      </div>
    </section>`;
}
