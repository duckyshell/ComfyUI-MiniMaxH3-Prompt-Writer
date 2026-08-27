/** Minimal same-origin replacement for ComfyUI's API object. */
export const api = {
  fetchApi(path, options = {}) {
    return fetch(path, options);
  },
};
