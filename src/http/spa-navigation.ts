/**
 * Decide whether a missing path may resolve to a single-page application's
 * HTML entry file.
 */
export function permitsSpaEntryFallback(headers: Headers): boolean {
  if (!acceptsHtml(headers.get("accept"))) return false;
  const destination = headers.get("sec-fetch-dest");
  if (destination !== null && destination.toLowerCase() !== "document") {
    return false;
  }
  const mode = headers.get("sec-fetch-mode");
  return mode === null || mode.toLowerCase() === "navigate";
}

/**
 * Decide whether a request is a person opening a page in a browser tab, as
 * opposed to a script, an embedded frame, or a subresource. Requests without
 * Fetch Metadata never count, so non-browser clients keep plain status codes.
 */
export function isDocumentNavigation(method: string, headers: Headers): boolean {
  return method === "GET"
    && headers.get("sec-fetch-mode")?.toLowerCase() === "navigate"
    && headers.get("sec-fetch-dest")?.toLowerCase() === "document";
}

function acceptsHtml(accept: string | null): boolean {
  if (accept === null) return false;
  return accept.split(",").some((candidate) => {
    const [mediaRange, ...parameters] = candidate.trim().toLowerCase().split(";");
    if (mediaRange !== "text/html") return false;
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    if (quality === undefined) return true;
    const value = Number(quality.trim().slice(2));
    return Number.isFinite(value) && value > 0;
  });
}
