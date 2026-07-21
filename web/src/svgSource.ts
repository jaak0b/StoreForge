/**
 * Fetching custom-icon SVG source from a link the user pastes into the icon
 * dialog. This lives outside web/src/engine/ on purpose: the engine stays
 * framework-agnostic and free of network access, so the fetch that turns a URL
 * into SVG text belongs here in the UI/store layer. The fetched text is then
 * handed to the same normalize pipeline as pasted markup.
 *
 * The fetch implementation is injected so the URL detection and the error
 * mapping can be unit-tested in node without a real network.
 */

/** Maximum size, in bytes, we will pull from a link for one icon. */
export const MAX_SVG_FETCH_BYTES = 1_000_000;

/** Outcome of fetching SVG text from a link. */
export type SvgFetchResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

const CORS_ERROR =
  'That link points to a site that does not allow other pages to download its ' +
  'files directly. Download the .svg file to your computer, then use the ' +
  'upload button below to add it.';
const FETCH_FAILED_ERROR =
  'The file at that link could not be fetched. Check that the link is correct ' +
  'and points straight at an .svg file, then try again.';
const TOO_LARGE_ERROR =
  'That file is larger than 1 MB, which is far too large for an icon. Pick a ' +
  'smaller SVG file.';

/**
 * Whether the input looks like an http(s) link rather than pasted SVG markup or
 * path data. A URL is a single token with an http(s) scheme; markup starts with
 * "<" and path data starts with a command letter, so neither matches.
 */
export function isProbablyUrl(input: string): boolean {
  return /^https?:\/\/\S+$/i.test(input.trim());
}

/**
 * Fetch SVG source text from a link. Network failures, blocked cross-origin
 * requests, non-OK responses and oversized files each come back as a worded
 * message the dialog can show; a success returns the raw text for the normalize
 * pipeline. `fetchImpl` defaults to the global fetch and is injected in tests.
 */
export async function fetchSvgText(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SvgFetchResult> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    // A browser reports a blocked cross-origin request as a TypeError with no
    // status, indistinguishable from an outright network failure; both mean the
    // page could not read the file, so we point the user at the upload button.
    if (error instanceof TypeError) return { ok: false, error: CORS_ERROR };
    return { ok: false, error: FETCH_FAILED_ERROR };
  }

  if (!response.ok) return { ok: false, error: FETCH_FAILED_ERROR };

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SVG_FETCH_BYTES) {
    return { ok: false, error: TOO_LARGE_ERROR };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, error: FETCH_FAILED_ERROR };
  }

  // Guard again after reading: a missing or wrong content-length header cannot
  // be trusted, so the actual byte length is the real limit.
  if (new Blob([text]).size > MAX_SVG_FETCH_BYTES) {
    return { ok: false, error: TOO_LARGE_ERROR };
  }

  return { ok: true, text };
}
