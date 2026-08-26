export const sha256 = async (body: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};
