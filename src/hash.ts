/** The SHA-256 of `data` (a string as UTF-8), in hex. */
export async function sha256(data: Uint8Array | string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
