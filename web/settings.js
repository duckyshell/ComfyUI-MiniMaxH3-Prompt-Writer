export function generateModelSummaryMarkup(icon) {
  return `
    <button class="h3ps-active-model" type="button" data-open-settings>
      <span class="h3ps-active-model-icon" data-active-model-icon>G</span>
      <span><small data-active-model-source>Prompt model</small><strong data-active-model-name>Scanning models…</strong></span>
      <em data-active-runtime-summary>Auto</em>
      ${icon("chevron", 14)}
    </button>`;
}

function systemPromptCard(profile, title, description, icon) {
  return `
    <section class="h3ps-settings-card h3ps-system-prompt-card" data-system-prompt-card="${profile}">
      <header>
        <span><small>System Prompt</small><strong>${title}</strong></span>
        <span><em data-system-prompt-status="${profile}">Default</em>${icon("check", 13)}</span>
      </header>
      <p>${description} Official MiniMax guides are applied separately and are not modified.</p>
      <textarea data-system-prompt="${profile}" maxlength="8000" spellcheck="true" disabled></textarea>
      <footer><small data-system-prompt-count="${profile}">0 / 8,000</small><button type="button" data-system-prompt-reset="${profile}" hidden>Reset to default</button></footer>
    </section>`;
}

export function settingsMarkup(icon) {
  return `
    <section class="h3ps-settings-view" data-settings-view hidden>
      <header class="h3ps-settings-heading">
        <span><small>H3 Prompt Writer</small><strong>Settings</strong><em>Inference, runtime and prompt behavior</em></span>
        <button class="h3ps-secondary-button" type="button" data-close-settings>${icon("chevron", 14)} Back to Generate</button>
      </header>

      <div class="h3ps-settings-content">
        <section class="h3ps-settings-card h3ps-inference-settings">
          <header><span><small>Inference</small><strong>Provider and model</strong></span><button type="button" data-model-refresh>${icon("refresh", 13)} Refresh</button></header>
          <div class="h3ps-model-picker" data-model-picker>
            <div class="h3ps-model-row">
              <span class="h3ps-model-icon">G</span>
              <span><small data-model-source-label>Local model</small><strong data-selected-model>Scanning models…</strong></span>
              <span class="h3ps-model-lifecycle" data-model-lifecycle hidden><em data-model-lifecycle-label>Model loaded</em></span>
              <button class="h3ps-icon-button" type="button" title="Model options" data-model-toggle>${icon("chevron", 16)}</button>
            </div>
            <div class="h3ps-model-menu" data-model-menu hidden>
              <header><span><strong>Prompt models</strong><small>Local GGUF or an existing llama.cpp server</small></span></header>
              <div class="h3ps-model-options"><div class="h3ps-model-empty">Scanning models…</div></div>
              <footer>
                <span>${icon("image", 12)} Images <b data-model-capability="images">No</b></span>
                <span>${icon("video", 12)} Video frames <b data-model-capability="video_frames">No</b></span>
                <span>${icon("audio", 12)} Audio <b data-model-capability="audio">Not analyzed</b></span>
                <span data-developer-mode hidden>Dev log <b>On</b></span>
              </footer>
            </div>
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

        <div class="h3ps-system-prompts-grid">
          ${systemPromptCard("standard", "Standard", "Instructions used by T2VA, I2VA, FL2VA and L2VA.", icon)}
          ${systemPromptCard("reference", "Reference", "Instructions used by Reference mode.", icon)}
        </div>
      </div>
    </section>`;
}
