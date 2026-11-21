// Longest script and voice instructions the app accepts. These live here,
// not in a route file: Next.js allows a route file to export only its
// handlers and settings, and rejects the production build otherwise.
//
// 3000 characters is about three minutes of speech, enough for a page of
// text or a few minutes of an uploaded recording.
export const MAX_INPUT_LENGTH = 3000;
export const MAX_PROMPT_LENGTH = 1000;

// Largest voice file that can be uploaded for transcription.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
