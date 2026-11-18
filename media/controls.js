(() => {
  'use strict';
  const api = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  document.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
    if (button && !button.disabled) api.postMessage({ action: button.dataset.action });
  });
  window.addEventListener('message', event => {
    const state = event.data;
    byId('summary').textContent = state.hasWorkspace ? `${state.unsaved} waiting to save · ${state.external} already on disk` : 'Open a folder to monitor workspace changes.';
    byId('save').textContent = state.saving ? 'Saving…' : `Save All (${state.unsaved})`;
    byId('save').disabled = state.saving || state.unsaved === 0;
    byId('stop').hidden = !state.saving;
    byId('progress').textContent = state.progress;
    byId('progress').hidden = !state.progress;
    byId('protection').textContent = `Editor Auto Save: ${state.autoSave}${state.protection ? ' · Protection enabled' : ''}`;
    byId('monitoring').textContent = state.monitoring;
    byId('issue').hidden = !state.issue;
    byId('issue').textContent = state.issue;
    byId('selected').hidden = !state.selected;
    if (state.selected) {
      byId('filename').textContent = state.selected.name;
      byId('file-state').textContent = state.selected.state;
      byId('save-file').hidden = !state.selected.canSave;
      byId('save-file').disabled = state.saving;
      byId('reviewed').hidden = !state.selected.canReview;
    }
  });
  api.postMessage({ action: 'ready' });
})();
