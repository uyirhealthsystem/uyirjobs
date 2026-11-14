import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useToast } from '../components/Toast.jsx';

const QUALIFICATIONS = ['ANM', 'GNM Diploma', 'B.Sc Nursing', 'Post Basic B.Sc Nursing', 'M.Sc Nursing'];
const WORK = ['Full-time', 'Part-time', 'Either'];
const EMPLOYMENT = ['Government hospital', 'Private hospital', 'Clinic / nursing home', 'Home care / self-employed', 'Not working currently'];
const SERVICES = ['Home nursing', 'Elderly care', 'Post-operative care', 'Palliative care', 'Mother & baby care', 'Injections & IV', 'Wound care', 'Physiotherapy assistance'];
// Block is not asked here (staff can still fill it in); the server keeps what is on file.
const FIELDS = ['address', 'email', 'taluk', 'qualification', 'council_reg_no', 'current_employment', 'experience_years', 'work_preference'];
const OTHER = '__other__';
// The one preferred work location is stored as "Village, Taluk (District)". Older records may hold
// several ("…; …") or just "Taluk (District)": the form starts from the first one.
function parseLocation(s, districts) {
  const first = String(s || '').split(';')[0].trim();
  const m = /^(?:(.*), )?([^,]+) \(([^()]+)\)$/.exec(first);
  if (!m || !districts.includes(m[3])) return { district: '', taluk: '', village: '' };
  return { district: m[3], taluk: m[2], village: m[1] || '' };
}

export function DetailsStep({ reg, d, refresh, onDone }) {
  const n = d.nurse;
  const toast = useToast();
  const taluks = d.taluks || {};
  const [f, setF] = useState(() => ({
    ...Object.fromEntries(FIELDS.map(k => [k, n[k] ?? ''])),
    name: n.name === 'Nurse' ? '' : n.name,
    qualification: n.qualification === 'Other' ? '' : n.qualification ?? '',
    district: n.district || '',
    services: new Set(String(n.service_interests || '').split(',').map(s => s.trim()).filter(Boolean)),
    consent: n.consent_given,
    consent_whatsapp: !n.consent_given || n.consent_whatsapp,
  }));
  const districtTaluks = taluks[f.district] || [];
  // A saved taluk that is not in the list was typed in under "Other".
  const [talukOther, setTalukOther] = useState(() => !!n.taluk && !(taluks[n.district] || []).includes(n.taluk));
  // Likewise for employment and qualification answers typed under "Other" (older records saved just "Other").
  const [employmentOther, setEmploymentOther] = useState(() => !!n.current_employment && !EMPLOYMENT.includes(n.current_employment));
  const [qualificationOther, setQualificationOther] = useState(() => !!n.qualification && !QUALIFICATIONS.includes(n.qualification));
  const [loc, setLoc] = useState(() => {
    const saved = parseLocation(n.preferred_locations, d.districts);
    return saved.district ? saved : { district: n.district || '', taluk: '', village: '' };
  });
  const villages = useQuery({
    queryKey: ['villages', loc.district, loc.taluk],
    queryFn: () => reg.get(`/villages?district=${encodeURIComponent(loc.district)}&taluk=${encodeURIComponent(loc.taluk)}`),
    enabled: !!(loc.district && loc.taluk),
    staleTime: Infinity,
  });
  const villageList = villages.data?.villages || [];
  // "Other" is on when chosen, or when a saved village is not in the list (it was typed in).
  const villageOther = loc.villageOther || (!!loc.village && !!villages.data && !villageList.includes(loc.village));

  const save = useMutation({
    mutationFn: () => {
      const { services, ...rest } = f;
      // ";" separates locations and "," the parts of one, so neither may appear in a typed village.
      const village = loc.village.replace(/[;,]/g, ' ').replace(/\s+/g, ' ').trim();
      return reg.post('/details', { ...rest, preferred_locations: `${village}, ${loc.taluk} (${loc.district})`, service_interests: [...services].join(', ') });
    },
    onSuccess: () => { toast('Details saved'); onDone(); refresh(); },
  });
  const set = k => e => setF(x => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const toggleService = s => setF(x => { const services = new Set(x.services); services.has(s) ? services.delete(s) : services.add(s); return { ...x, services }; });
  const Text = ({ k, label, type = 'text', ...rest }) => (
    <label className="f"><span>{label} *</span><input type={type} value={f[k]} onChange={set(k)} required maxLength={1000} {...rest} /></label>
  );

  function chooseDistrict(e) {
    const district = e.target.value;
    setF(x => ({ ...x, district, taluk: '' }));
    setTalukOther(false);
    setLoc(l => (l.district ? l : { district, taluk: '', village: '' }));
  }
  function chooseQualification(e) {
    const v = e.target.value;
    setQualificationOther(v === OTHER);
    setF(x => ({ ...x, qualification: v === OTHER ? '' : v }));
  }
  function chooseEmployment(e) {
    const v = e.target.value;
    setEmploymentOther(v === OTHER);
    setF(x => ({ ...x, current_employment: v === OTHER ? '' : v }));
  }
  function chooseTaluk(e) {
    const v = e.target.value;
    setTalukOther(v === OTHER);
    setF(x => ({ ...x, taluk: v === OTHER ? '' : v }));
  }
  function submit(e) {
    e.preventDefault();
    if (!loc.district || !loc.taluk || !loc.village.trim()) return toast('Choose your preferred work location: district, taluk and village', true);
    if (!f.services.size) return toast('Choose at least one service you are interested in', true);
    save.mutate();
  }

  return (
    <>
      <div className="step">Step 1 of 3 · Your details</div>
      <h1>Your details</h1>
      <p className="muted"><span className="mono">{n.mobile}</span> · all fields are required</p>
      <form onSubmit={submit}>
        {Text({ k: 'name', label: 'Full name (as on your nursing certificate)', maxLength: 200, autoComplete: 'name' })}
        {Text({ k: 'address', label: 'Address', autoComplete: 'street-address' })}
        {Text({ k: 'email', label: 'Email', type: 'email', autoComplete: 'email' })}

        <label className="f"><span>District *</span>
          <select value={f.district} onChange={chooseDistrict} required>
            <option value="">Select…</option>{d.districts.map(x => <option key={x}>{x}</option>)}
          </select>
        </label>

        <label className="f"><span>Taluk *</span>
          <select value={talukOther ? OTHER : f.taluk} onChange={chooseTaluk} required disabled={!f.district}>
            <option value="">{f.district ? 'Select…' : 'Choose your district first'}</option>
            {districtTaluks.map(x => <option key={x}>{x}</option>)}
            <option value={OTHER}>Other (not listed)</option>
          </select>
        </label>
        {talukOther && Text({ k: 'taluk', label: 'Your taluk' })}

        <fieldset className="f plain">
          <legend className="small"><span>Preferred work location *</span> <span className="muted">(one place)</span></legend>
          <div className="locpick">
            <select aria-label="Work location district" value={loc.district} onChange={e => setLoc({ district: e.target.value, taluk: '', village: '' })} required>
              <option value="">District…</option>{d.districts.map(x => <option key={x}>{x}</option>)}
            </select>
            <select aria-label="Work location taluk" value={loc.taluk} onChange={e => setLoc(l => ({ ...l, taluk: e.target.value, village: '', villageOther: false }))} disabled={!loc.district} required>
              <option value="">Taluk…</option>{(taluks[loc.district] || []).map(x => <option key={x}>{x}</option>)}
            </select>
            <select aria-label="Work location village" value={villageOther ? OTHER : loc.village}
              onChange={e => setLoc(l => ({ ...l, villageOther: e.target.value === OTHER, village: e.target.value === OTHER ? '' : e.target.value }))} disabled={!villages.data} required>
              <option value="">{villages.isFetching ? 'Loading villages…' : 'Village…'}</option>
              {villageList.map(x => <option key={x}>{x}</option>)}
              <option value={OTHER}>Other (not listed)</option>
            </select>
            {villageOther && (
              <input type="text" className="wide" aria-label="Village or area name" placeholder="Type the village or area" maxLength={100} required
                value={loc.village} onChange={e => setLoc(l => ({ ...l, village: e.target.value }))} />
            )}
          </div>
          {villages.isError && <p className="small" role="alert">Could not load villages. Check your connection and choose the taluk again.</p>}
        </fieldset>

        <label className="f"><span>Qualification *</span>
          <select value={qualificationOther ? OTHER : f.qualification} onChange={chooseQualification} required>
            <option value="">Select…</option>{QUALIFICATIONS.map(q => <option key={q}>{q}</option>)}
            <option value={OTHER}>Other</option>
          </select>
        </label>
        {qualificationOther && Text({ k: 'qualification', label: 'Your qualification' })}
        {Text({ k: 'council_reg_no', label: 'Nursing Council registration number' })}
        <label className="f"><span>Current employment *</span>
          <select value={employmentOther ? OTHER : f.current_employment} onChange={chooseEmployment} required>
            <option value="">Select…</option>{EMPLOYMENT.map(x => <option key={x}>{x}</option>)}
            <option value={OTHER}>Other</option>
          </select>
        </label>
        {employmentOther && Text({ k: 'current_employment', label: 'Your current employment' })}
        <label className="f"><span>Years of experience * <span className="muted small">(0 if none)</span></span>
          <input type="number" min="0" max="60" step="0.5" inputMode="decimal" value={f.experience_years} onChange={set('experience_years')} required />
        </label>
        <label className="f"><span>Work preference *</span>
          <select value={f.work_preference} onChange={set('work_preference')} required>
            <option value="">Select…</option>{WORK.map(q => <option key={q}>{q}</option>)}
          </select>
        </label>
        <fieldset className="f plain">
          <legend className="small muted">Services you are interested in * (choose at least one)</legend>
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
