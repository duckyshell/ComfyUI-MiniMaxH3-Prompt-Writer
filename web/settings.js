import { t } from "./i18n.js";

export function generateModelSummaryMarkup(icon) {
  return `
    <button class="h3ps-active-model" type="button" title="${t("settings.open_model")}" data-i18n-title="settings.open_model" data-open-settings>
      <span class="h3ps-active-model-icon h3ps-provider-icon" data-active-model-icon data-provider-icon="direct" aria-hidden="true"></span>
      <span><small data-active-model-source data-i18n="models.prompt_model">Prompt model</small><strong data-active-model-name data-i18n="models.scanning">Scanning models…</strong></span>
      <em data-active-runtime-summary data-i18n="models.runtime_summary">Runtime · Auto</em>
      ${icon("chevron", 14)}
    </button>`;
}

function systemPromptPanel(profile, labelKey, descriptionKey, icon, hidden = false) {
  return `
    <div class="h3ps-system-prompt-panel" data-system-prompt-panel="${profile}" ${hidden ? "hidden" : ""}>
      <header class="h3ps-system-prompt-editor-heading">
        <button type="button" data-system-prompt-back>${icon("chevron", 12)} <span data-i18n="system_prompt.back">Back</span></button>
        <span><small data-i18n="system_prompt.title">System prompt</small><strong data-i18n="${labelKey}">${t(labelKey)}</strong></span>
        <span class="h3ps-system-prompt-panel-status"><em data-system-prompt-status="${profile}" data-i18n="system_prompt.status">Default</em>${icon("check", 13)}</span>
      </header>
      <p><span data-i18n="${descriptionKey}">${t(descriptionKey)}</span> <span data-i18n="system_prompt.official_note">Official MiniMax guides are applied separately and are not modified.</span></p>
      <textarea data-system-prompt="${profile}" maxlength="8000" spellcheck="true" disabled></textarea>
      <footer><small data-system-prompt-count="${profile}">0 / 8,000</small><button type="button" data-system-prompt-reset="${profile}" hidden data-i18n="settings.reset_default">Reset to default</button></footer>
    </div>`;
}

export function settingsMarkup(icon) {
  return `
    <section class="h3ps-settings-view" data-settings-view hidden>
      <header class="h3ps-settings-heading">
        <span><strong data-i18n="settings.title">Settings</strong><em data-i18n="settings.subtitle">Inference, runtime and prompt behavior</em></span>
        <button class="h3ps-secondary-button" type="button" data-close-settings>${icon("chevron", 14)} <span data-i18n="settings.back_generate">Back to Generate</span></button>
      </header>

      <div class="h3ps-settings-content">
        <section class="h3ps-settings-card h3ps-provider-settings">
          <header><span><small data-i18n="settings.inference">Inference</small><strong data-i18n="settings.provider">Provider</strong></span></header>
          <div class="h3ps-provider-selector" role="tablist" aria-label="${t("settings.provider_aria")}" data-i18n-aria-label="settings.provider_aria">
            <button type="button" role="tab" data-provider-option="ollama" aria-selected="true">
              <span class="h3ps-provider-icon" data-provider-icon="ollama" aria-hidden="true"></span><span><strong data-i18n="settings.ollama">Ollama</strong><small data-i18n="settings.ollama_hint">Simple local model service</small></span>${icon("check", 14)}
            </button>
            <button type="button" role="tab" data-provider-option="direct" aria-selected="false">
              <span class="h3ps-provider-icon" data-provider-icon="direct" aria-hidden="true"></span><span><strong data-i18n="settings.direct">Direct GGUF</strong><small data-i18n="settings.direct_hint">Models installed in ComfyUI</small></span>${icon("check", 14)}
            </button>
            <button type="button" role="tab" data-provider-option="external" aria-selected="false">
              <span class="h3ps-provider-icon" data-provider-icon="external" aria-hidden="true"></span><span><strong data-i18n="settings.external">External llama.cpp</strong><small data-i18n="settings.external_hint">Existing local llama-server</small></span>${icon("check", 14)}
            </button>
            <button type="button" role="tab" data-provider-option="api" aria-selected="false">
              <span class="h3ps-provider-icon" data-provider-icon="api" aria-hidden="true"></span><span><strong data-i18n="settings.api">API providers</strong><small data-i18n="settings.api_hint">OpenAI-compatible local or remote API</small></span>${icon("check", 14)}
            </button>
          </div>
        </section>

        <section class="h3ps-settings-card h3ps-provider-detail" data-provider-detail>
          <div class="h3ps-provider-panel" data-provider-panel="direct" hidden>
            <div data-direct-runtime-status></div>
            <header class="h3ps-settings-section-heading">
              <span><small data-i18n="settings.model">Model</small><strong data-i18n="settings.installed_models">Installed models</strong></span>
              <button class="h3ps-small-refresh" type="button" data-model-refresh>${icon("refresh", 13)} <span data-i18n="common.refresh">Refresh</span></button>
            </header>
            <div class="h3ps-installed-model-heading" data-i18n="settings.select_model">Select Model</div>
            <div class="h3ps-installed-model-control">
              <span class="h3ps-model-icon h3ps-provider-icon" data-provider-icon="direct" aria-hidden="true"></span>
              <label><select data-installed-model aria-label="${t("settings.installed_model_aria")}" data-i18n-aria-label="settings.installed_model_aria"><option data-i18n="settings.scanning_models">Scanning models…</option></select></label>
              <span class="h3ps-model-lifecycle" data-model-lifecycle hidden><em data-model-lifecycle-label data-i18n="settings.model_loaded">Model loaded</em></span>
            </div>
            <p class="h3ps-installed-model-source" data-model-source-label data-i18n="settings.local_runtime">Local GGUF · llama-cpp-python</p>
            <div data-direct-model-status></div>
            <div data-direct-projector></div>
            <div class="h3ps-model-utilities">
              <div data-model-scan-slot></div>
              <div data-verified-models-slot></div>
            </div>
          </div>

          <div class="h3ps-provider-panel" data-provider-panel="external" hidden>
            <header class="h3ps-settings-section-heading"><span><small data-i18n="settings.connection">Connection</small><strong data-i18n="settings.external_server">External llama.cpp server</strong></span></header>
            <div data-external-provider-control></div>
          </div>

          <div class="h3ps-provider-panel" data-provider-panel="ollama">
            <div data-ollama-provider-control></div>
          </div>

          <div class="h3ps-provider-panel" data-provider-panel="api" hidden>
            <div data-api-provider-control></div>
          </div>

        </section>

        <section class="h3ps-settings-card h3ps-runtime-settings">
          <header><span><small data-i18n="settings.runtime">Runtime</small></span></header>
          <div class="h3ps-runtime-settings-grid">
            <div class="h3ps-runtime-control"><span data-i18n="settings.context">Context</span><span class="h3ps-runtime-picker"><button type="button" aria-haspopup="true" aria-expanded="false" data-runtime-toggle="context"><b data-runtime-label="context" data-i18n="settings.auto">Auto</b>${icon("chevron", 12)}</button><span class="h3ps-runtime-menu" data-runtime-menu="context" hidden><button type="button" data-runtime-option="context" data-value="auto" data-i18n="settings.auto">Auto</button><button type="button" data-runtime-option="context" data-value="low">8K</button><button type="button" data-runtime-option="context" data-value="standard">16K</button><button type="button" data-runtime-option="context" data-value="extended">24K</button><button type="button" data-runtime-option="context" data-value="large">32K</button><button type="button" data-runtime-option="context" data-value="maximum">48K</button><button type="button" data-runtime-option="context" data-value="custom" data-i18n="settings.custom">Custom</button></span></span><label class="h3ps-runtime-custom" data-custom-context hidden><input type="number" min="1024" step="1" inputmode="numeric" placeholder="${t("settings.enter_tokens")}" data-i18n-placeholder="settings.enter_tokens" data-custom-context-input><span data-i18n="settings.tokens">tokens</span></label></div>
          </div>
          <details class="h3ps-direct-advanced" data-direct-runtime-advanced>
            <summary><strong data-i18n="settings.advanced">Advanced settings</strong><em data-direct-advanced-summary data-i18n="settings.auto">Auto</em>${icon("chevron", 12)}</summary>
            <div class="h3ps-direct-advanced-body">
              <div class="h3ps-runtime-control"><span data-i18n="settings.kv_cache">KV cache</span><span class="h3ps-runtime-picker"><button type="button" aria-haspopup="true" aria-expanded="false" data-runtime-toggle="kv"><b data-runtime-label="kv" data-i18n="settings.auto">Auto</b>${icon("chevron", 12)}</button><span class="h3ps-runtime-menu" data-runtime-menu="kv" hidden><button type="button" data-runtime-option="kv" data-value="auto" data-i18n="settings.auto">Auto</button><button type="button" data-runtime-option="kv" data-value="q8">Q8</button><button type="button" data-runtime-option="kv" data-value="f16">F16</button></span></span></div>
              <div class="h3ps-runtime-control"><span data-i18n="settings.generation_budget">Generation budget</span><span class="h3ps-runtime-picker"><button type="button" aria-haspopup="true" aria-expanded="false" data-runtime-toggle="budget"><b data-runtime-label="budget" data-i18n="settings.auto">Auto</b>${icon("chevron", 12)}</button><span class="h3ps-runtime-menu" data-runtime-menu="budget" hidden><button type="button" data-runtime-option="budget" data-value="auto" data-i18n="settings.auto">Auto</button><button type="button" data-runtime-option="budget" data-value="2048">2K</button><button type="button" data-runtime-option="budget" data-value="4096">4K</button><button type="button" data-runtime-option="budget" data-value="8192">8K</button><button type="button" data-runtime-option="budget" data-value="custom" data-i18n="settings.custom">Custom</button></span></span><label class="h3ps-runtime-custom" data-custom-generation-budget hidden><input type="number" min="1" step="1" inputmode="numeric" placeholder="${t("settings.enter_tokens")}" data-i18n-placeholder="settings.enter_tokens" data-custom-generation-budget-input><span data-i18n="settings.tokens">tokens</span></label></div>
              <div class="h3ps-runtime-control" data-reasoning-effort-control hidden><span data-i18n="settings.reasoning_effort">Reasoning effort</span><span class="h3ps-runtime-picker"><button type="button" aria-haspopup="true" aria-expanded="false" data-runtime-toggle="reasoning"><b data-runtime-label="reasoning" data-i18n="settings.auto">Auto</b>${icon("chevron", 12)}</button><span class="h3ps-runtime-menu" data-runtime-menu="reasoning" hidden></span></span></div>
            </div>
          </details>
          <p data-runtime-management data-i18n="settings.runtime_note">Direct GGUF runtime settings are applied to the next request.</p>
        </section>

        <section class="h3ps-settings-card h3ps-system-prompt-card">
          <header><span><small data-i18n="settings.prompt_behavior">Prompt behavior · shared by all providers</small><strong data-i18n="settings.system_prompt">System Prompt</strong></span></header>
          <div class="h3ps-system-prompt-overview" data-system-prompt-overview>
            <button type="button" data-system-prompt-profile="standard">
              <span><strong data-i18n="settings.standard">Standard</strong><small>T2VA · I2VA · FL2VA · L2VA</small></span>
              <span><em data-system-prompt-summary-status="standard" data-i18n="system_prompt.status">Default</em><b data-i18n="common.edit">Edit</b>${icon("chevron", 12)}</span>
            </button>
            <button type="button" data-system-prompt-profile="reference">
              <span><strong data-i18n="settings.reference">Reference</strong><small data-i18n="settings.reference_mode">Reference mode</small></span>
              <span><em data-system-prompt-summary-status="reference" data-i18n="system_prompt.status">Default</em><b data-i18n="common.edit">Edit</b>${icon("chevron", 12)}</span>
            </button>
          </div>
          <div class="h3ps-system-prompt-editor" data-system-prompt-editor hidden>
            ${systemPromptPanel("standard", "settings.standard", "system_prompt.standard_description", icon)}
            ${systemPromptPanel("reference", "settings.reference", "system_prompt.reference_description", icon, true)}
          </div>
          <div class="h3ps-draft-defaults-action" data-draft-defaults-action>
            <button type="button" data-restore-default-drafts>${icon("refresh", 13)}<span data-restore-default-drafts-label data-i18n="settings.restore_drafts">Restore default drafts</span></button>
          </div>
        </section>
        <section class="h3ps-settings-card h3ps-notifications-settings">
          <header><span><small data-i18n="settings.notifications">Notifications</small></span></header>
          <label class="h3ps-toggle-control"><input type="checkbox" data-desktop-notifications><span></span><span data-i18n="settings.desktop_notifications">Desktop notifications</span></label>
          <p class="h3ps-field-help" data-desktop-notifications-hint></p>
        </section>
      </div>
    </section>`;
}
