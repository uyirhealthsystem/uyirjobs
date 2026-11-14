import { YouTube } from '../components/YouTube.jsx';

// First screen of the nurse portal: who we are, before the nurse starts registering.
// The trust points describe what the system really does (see server/src: KMS-encrypted S3 and RDS
// in ap-south-1, bank numbers AES-encrypted and shown back as the last 4 digits only).
const TRUST = [
  ['🔒', 'Your information is safe', 'Your details and documents are encrypted and stored securely on servers in India.'],
  ['✅', 'Verified by our district team', 'Every registration is personally reviewed before a nurse is approved.'],
  ['🏦', 'Bank details protected', 'Asked for only after you are verified, and never shown in full to anyone.'],
  ['⏱️', 'Takes about 10 minutes', 'Keep your nursing certificate, council registration and a government ID ready.'],
];

export function WelcomeStep({ info, onStart }) {
  return (
    <div className="welcome">
      <h1 className="welcome-title">Uyir Health App</h1>
      <img className="welcome-logo" src="/uyir-logo.jpeg" alt="Uyir Health App logo" width="140" height="114" />
      <p className="welcome-company">A part of <b>Uyir Digital Health Systems Private Limited</b></p>
      <p className="welcome-badge">✓ Recognised by the Government of India</p>
      <p className="welcome-cin">CIN: <span className="mono">U62099TN2026PTC195214</span></p>

      <p className="welcome-slogan">Connecting every village to a health facility</p>
      <p className="muted welcome-intro">
        Vanakkam {info.first_name}! Join a trusted network of nurses bringing quality care closer to
        families across Tamil Nadu.
      </p>

      <YouTube id="RrCTiMxtG3Y" title="Overview About Uyir Health App" />

      <ul className="welcome-trust">
        {TRUST.map(([icon, title, text]) => (
          <li key={title}>
            <span className="welcome-icon" aria-hidden="true">{icon}</span>
            <span><b>{title}</b><br /><span className="small muted">{text}</span></span>
          </li>
        ))}
      </ul>

      <button className="btn primary block welcome-start" onClick={onStart}>Start registration</button>
    </div>
  );
}
