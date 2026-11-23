// A caller can use ?renderer=cpu to keep this visit on the site's own
// machine even while the rental is awake. Only the two same-origin
// avatar routes consume this preference; no third-party address is accepted.
export function withRendererPreference(url: string): string {
  if (typeof window === "undefined" ||
      new URLSearchParams(window.location.search).get("renderer") !== "cpu") return url;
  return url + (url.includes("?") ? "&renderer=cpu" : "?renderer=cpu");
}
