import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useToast } from '../components/Toast.jsx';

const QUALIFICATIONS = ['ANM', 'GNM Diploma', 'B.Sc Nursing', 'Post Basic B.Sc Nursing', 'M.Sc Nursing', 'Other'];
const WORK = ['Full-time', 'Part-time', 'Either'];
const SERVICES = ['Home nursing', 'Elderly care', 'Post-operative care', 'Palliative care', 'Mother & baby care', 'Injections & IV', 'Wound care', 'Physiotherapy assistance'];
const FIELDS = ['email', 'address', 'taluk', 'block', 'qualification', 'council_reg_no', 'current_employment', 'experience_years', 'work_preference', 'preferred_locations'];

export function DetailsStep({ reg, d, refresh, onDone }) {
  const n = d.nurse;
  const toast = useToast();
  const [f, setF] = useState(() => ({
    ...Object.fromEntries(FIELDS.map(k => [k, n[k] ?? ''])),
    services: new Set(String(n.service_interests || '').split(',').map(s => s.trim()).filter(Boolean)),
    consent: n.consent_given,
    consent_whatsapp: !n.consent_given || n.consent_whatsapp,
    // Started on WhatsApp: name (prefilled from their WhatsApp profile) and district come from the nurse.
    ...(n.needs_profile ? { name: n.name === 'Nurse' ? '' : n.name, district: '' } : {}),
  }));
  const save = useMutation({
    mutationFn: () => {
      const { services, ...rest } = f;
      return reg.post('/details', { ...rest, service_interests: [...services].join(', ') });
    },
    onSuccess: () => { toast('Details saved'); onDone(); refresh(); },
  });
  const set = k => e => setF(x => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const toggleService = s => setF(x => { const services = new Set(x.services); services.has(s) ? services.delete(s) : services.add(s); return { ...x, services }; });
  const Text = ({ k, label, required }) => (
    <label className="f"><span>{label}{required && ' *'}</span><input type="text" value={f[k]} onChange={set(k)} required={required} maxLength={1000} /></label>
  );

  return (
    <>
      <div className="step">Step 1 of 3 · Your details</div>
      <h1>{n.needs_profile ? 'Your details' : n.name}</h1>
      <p className="muted">{n.district && `${n.district} district · `}<span className="mono">{n.mobile}</span></p>
      <form onSubmit={e => { e.preventDefault(); save.mutate(); }}>
        {n.needs_profile && <>
          {Text({ k: 'name', label: 'Full name (as on your nursing certificate)', required: true })}
          <label className="f"><span>District *</span>
            <select value={f.district} onChange={set('district')} required>
              <option value="">Select…</option>{d.districts.map(x => <option key={x}>{x}</option>)}
            </select>
          </label>
        </>}
        <label className="f"><span>Email (optional)</span><input type="email" value={f.email} onChange={set('email')} autoComplete="email" /></label>
        {Text({ k: 'address', label: 'Address', required: true })}
        {Text({ k: 'taluk', label: 'Taluk', required: true })}
        {Text({ k: 'block', label: 'Block' })}
        <label className="f"><span>Qualification *</span>
          <select value={f.qualification} onChange={set('qualification')} required>
            <option value="">Select…</option>{QUALIFICATIONS.map(q => <option key={q}>{q}</option>)}
          </select>
        </label>
        {Text({ k: 'council_reg_no', label: 'Nursing Council registration number', required: true })}
        {Text({ k: 'current_employment', label: 'Current employment (hospital / self-employed / not working)' })}
        <label className="f"><span>Years of experience</span>
          <input type="number" min="0" max="60" step="0.5" inputMode="decimal" value={f.experience_years} onChange={set('experience_years')} />
        </label>
        <label className="f"><span>Work preference *</span>
          <select value={f.work_preference} onChange={set('work_preference')} required>
            <option value="">Select…</option>{WORK.map(q => <option key={q}>{q}</option>)}
          </select>
        </label>
        {Text({ k: 'preferred_locations', label: 'Preferred work locations (towns / areas)' })}
        <fieldset className="f plain">
          <legend className="small muted">Services you are interested in</legend>
          {SERVICES.map(s => <label key={s} className="chk"><input type="checkbox" checked={f.services.has(s)} onChange={() => toggleService(s)} /> {s}</label>)}
        </fieldset>
        <hr />
        <label className="chk"><input type="checkbox" checked={f.consent} onChange={set('consent')} required />
          <span>I agree that Uyir may store and process my details and documents to verify my credentials and offer me nursing work. *</span></label>
        <label className="chk"><input type="checkbox" checked={f.consent_whatsapp} onChange={set('consent_whatsapp')} />
          <span>Send me updates on WhatsApp (corrections, reminders, verification). <b>Needed to hear back from us.</b></span></label>
        {save.isError && <div className="banner dnc" role="alert">{save.error.message}</div>}
        <button className="btn primary block" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save and continue'}</button>
      </form>
    </>
  );
}
