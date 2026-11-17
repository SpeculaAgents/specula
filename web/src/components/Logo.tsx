/* eslint-disable @next/next/no-img-element */
// The mark is web/public/logo.png (transparent), made from the owner's logo file. The favicon is src/app/icon.png, the
// phone icons src/app/apple-icon.png and public/pwa-192.png / pwa-512.png, the share card reads public/logo-large.png.
export function Logo() {
  return (
    <>
      <img src="/logo.png" alt="" width={26} height={26} style={{ height: 26, width: 26 }} />
      <span>Specula</span>
    </>
  );
}
