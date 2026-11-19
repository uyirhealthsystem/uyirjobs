// Screenshot / screen-recording deterrents for District Admins.
//
// A web page cannot truly stop screenshots or screen recording (the operating system, phone
// screenshots and a camera are outside the browser's control). What this does:
//  • a visible watermark with the signed-in user, district and time over every screen, so any
//    capture or photo that leaks can be traced back to who took it;
//  • hides the screen when the window loses focus or is hidden (Windows Snipping Tool, Win+Shift+S,
//    the Print Screen tool on Windows 11 and most capture tools take focus first);
//  • on Print Screen, hides the screen and overwrites the clipboard;
//  • blocks printing, saving the page, right-click, copying, text selection and dragging.
import { useEffect, useState } from 'react';

const stamp = () => new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

function watermarkUrl(text) {
  const esc = text.replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="220"><text x="10" y="140" transform="rotate(-24 210 110)"
    font-family="Segoe UI, Arial, sans-serif" font-size="16" fill="#1d2330" fill-opacity="0.13">${esc}</text></svg>`;
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
}

const isField = el => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

export function ScreenGuard({ user }) {
  const [now, setNow] = useState(stamp);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(stamp()), 30e3);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    document.body.classList.add('guarded');
    let flash;
    const hideFor = ms => { setHidden(true); clearTimeout(flash); flash = setTimeout(() => setHidden(!document.hasFocus() || document.hidden), ms); };
    const update = () => setHidden(document.hidden || !document.hasFocus());
    // Focus moving into the in-app document viewer (an iframe) also blurs the window: keep showing it then.
    const onBlur = () => setTimeout(() => { if (document.activeElement?.tagName !== 'IFRAME') setHidden(true); }, 0);
    const onKeyDown = e => {
      const k = e.key?.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && ['p', 's'].includes(k)) { e.preventDefault(); hideFor(1500); }   // print / save page
      if (e.metaKey && e.shiftKey) hideFor(3000);                                                       // macOS ⌘⇧3/4/5, Win+Shift+S
      if (k === 'meta' || k === 'os') hideFor(1500);                                                    // Windows key (snipping shortcuts)
      if (k === 'printscreen') { e.preventDefault(); hideFor(3000); }
    };
    const onKeyUp = e => {
      if (e.key === 'PrintScreen') {
        hideFor(3000);
        navigator.clipboard?.writeText('Screenshots are not allowed in Uyir Nurse Registration').catch(() => {});
      }
    };
    const block = e => { if (!isField(e.target)) e.preventDefault(); };
    const onBeforePrint = () => setHidden(true);

    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('beforeprint', onBeforePrint);
    window.addEventListener('afterprint', update);
    for (const ev of ['contextmenu', 'copy', 'cut', 'dragstart', 'selectstart']) document.addEventListener(ev, block);
    return () => {
      document.body.classList.remove('guarded');
      clearTimeout(flash);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('beforeprint', onBeforePrint);
      window.removeEventListener('afterprint', update);
      for (const ev of ['contextmenu', 'copy', 'cut', 'dragstart', 'selectstart']) document.removeEventListener(ev, block);
    };
  }, []);

  const label = `${user.name} · ${user.username} · ${user.district || ''} · ${now}`;
  return (
    <>
      <div className="watermark" aria-hidden="true" style={{ backgroundImage: watermarkUrl(label) }} />
      {hidden && (
        <div className="screen-shield" role="alert" onClick={() => setHidden(false)}>
          <div>
            <b>Screen hidden</b>
            <div className="small">Screenshots and screen recording are not allowed. Click here to continue.</div>
          </div>
        </div>
      )}
    </>
  );
}
