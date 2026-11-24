export function safePath(value) {
  const path = value.normalize('NFC');
  if (path.length > 480 || path.includes('\\') || /[\x00-\x1f\x7f:]/u.test(path) ||
      path.split('/').some(segment => !segment || segment.startsWith('.') || /^(?:__MACOSX|node_modules|__pycache__|id_rsa|id_ed25519)$/i.test(segment)) ||
      /\.(?:pem|key|pfx|p12|keystore)$/i.test(path)) return null;
  return path;
}
