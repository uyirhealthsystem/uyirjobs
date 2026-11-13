// Single source of truth for nurse information collection: statuses, who may change
// them, staff roles and the document policy.
//
//   New ─invite─▶ Invited ─nurse registers─▶ Registered (documents pending)
//       ─nurse submits─▶ Submitted ─review─▶ Verified | Correction Required | Rejected
//   Correction Required ─nurse re-submits─▶ Submitted.   Verified → nurse adds bank details.

export const STATUSES = {
  NEW:                 { label: 'Not Invited',           stage: 0, group: 'new' },
  INVITED:             { label: 'Invited',               stage: 1, group: 'invite' },
  REGISTERED:          { label: 'Registered – Documents Pending', stage: 2, group: 'registration' },
  SUBMITTED:           { label: 'Submitted – Under Review',       stage: 3, group: 'review' },
  CORRECTION_REQUIRED: { label: 'Correction Required',   stage: 3, group: 'review' },
  REJECTED:            { label: 'Rejected',              stage: 3, group: 'closed' },
  VERIFIED:            { label: 'Verified',              stage: 4, group: 'done' },
};

// Progress: a nurse counts in every step up to the furthest one reached (nurses.stage_reached).
export const FUNNEL = [
  { stage: 0, label: 'Nurses' },
  { stage: 1, label: 'Invited' },
  { stage: 2, label: 'Registered' },
  { stage: 3, label: 'Submitted' },
  { stage: 4, label: 'Verified' },
];

// from -> allowed targets
export const TRANSITIONS = {
  NEW:                 ['INVITED'],
  INVITED:             ['INVITED', 'REGISTERED'],          // INVITED again = resend the link
  REGISTERED:          ['SUBMITTED'],
  SUBMITTED:           ['VERIFIED', 'CORRECTION_REQUIRED', 'REJECTED'],
  CORRECTION_REQUIRED: ['SUBMITTED'],
  REJECTED:            [],
  VERIFIED:            [],
};

// Set by the nurse through the registration portal, never by staff.
const PORTAL_ONLY = ['REGISTERED', 'SUBMITTED'];

export const ROLES = {
  super_admin:    { label: 'Super Admin',    hint: 'All districts. Everything a District Admin can do, plus staff accounts, moving nurses between districts and imports for any district.' },
  district_admin: { label: 'District Admin', hint: 'Full admin actions for their own district: add / import nurses, send invites, edit details, review documents, Do Not Contact, export.' },
};

export function canTransition(from, to, role) {
  if (!(TRANSITIONS[from] || []).includes(to)) return { ok: false, reason: `Cannot move from ${STATUSES[from]?.label} to ${STATUSES[to]?.label}` };
  if (role === 'system') return { ok: true };
  if (PORTAL_ONLY.includes(to)) return { ok: false, reason: 'Set by the nurse through the registration link' };
  if (!ROLES[role]) return { ok: false, reason: 'Not permitted' };
  return { ok: true };
}

// ---------------- upgrade mapping (old CRM data → information collection) ----------------
export const LEGACY_STATUS = {
  NOT_CONTACTED: 'NEW', NO_ANSWER: 'NEW', INVALID_NUMBER: 'NEW', NEED_INFO: 'NEW', NOT_INTERESTED: 'NEW', DO_NOT_CONTACT: 'NEW',
  INTERESTED: 'INVITED', REG_LINK_SENT: 'INVITED',
  REG_COMPLETED: 'REGISTERED', DOCS_PENDING: 'REGISTERED',
  DOCS_SUBMITTED: 'SUBMITTED',
  ACCOUNT_CREATED: 'VERIFIED', TRAINING: 'VERIFIED', ACTIVE: 'VERIFIED',
};
// Old roles → new. Roles that no longer exist are deactivated (never silently upgraded).
export const LEGACY_ROLE = { state_admin: 'super_admin', district_coordinator: 'district_admin' };

// Onboarding document policy. `required` is true/false or the name of a rule
// evaluated against the nurse's registration details. Add policy documents here;
// the portal, review screen and "Verified" check all follow this table.
export const DOC_TYPES = {
  QUALIFICATION: { label: 'Nursing qualification certificate', required: true },
  COUNCIL_REG:   { label: 'Nursing council registration',      required: true },
  GOVT_ID:       { label: 'Government ID',                     required: true },
  EXPERIENCE:    { label: 'Experience documents',              required: 'has_experience', hint: 'Required if you declared nursing experience' },
  OTHER:         { label: 'Other',                             required: false },
};

const REQUIRED_RULES = {
  has_experience: n => Number(n?.experience_years) > 0,
};

export function isDocRequired(type, nurse) {
  const r = DOC_TYPES[type]?.required;
  return typeof r === 'string' ? !!REQUIRED_RULES[r]?.(nurse) : !!r;
}
export const requiredDocTypes = nurse => Object.keys(DOC_TYPES).filter(k => isDocRequired(k, nurse));

// Bank / payment details are collected once the nurse is verified.
export const PAYOUT_STATUSES = ['VERIFIED'];
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export const DISTRICTS = [
  'Ariyalur', 'Chengalpattu', 'Chennai', 'Coimbatore', 'Cuddalore', 'Dharmapuri', 'Dindigul', 'Erode',
  'Kallakurichi', 'Kancheepuram', 'Kanniyakumari', 'Karur', 'Krishnagiri', 'Madurai', 'Mayiladuthurai',
  'Nagapattinam', 'Namakkal', 'Nilgiris', 'Perambalur', 'Pudukkottai', 'Ramanathapuram', 'Ranipet', 'Salem',
  'Sivaganga', 'Tenkasi', 'Thanjavur', 'Theni', 'Thoothukudi', 'Tiruchirappalli', 'Tirunelveli', 'Tirupathur',
  'Tiruppur', 'Tiruvallur', 'Tiruvannamalai', 'Tiruvarur', 'Vellore', 'Viluppuram', 'Virudhunagar',
];

const DISTRICT_ALIASES = {
  kanyakumari: 'Kanniyakumari', tuticorin: 'Thoothukudi', trichy: 'Tiruchirappalli', tiruchy: 'Tiruchirappalli',
  kanchipuram: 'Kancheepuram', villupuram: 'Viluppuram', 'the nilgiris': 'Nilgiris', ooty: 'Nilgiris',
  thiruvallur: 'Tiruvallur', thiruvarur: 'Tiruvarur', thiruvannamalai: 'Tiruvannamalai', tirupur: 'Tiruppur',
  thirupathur: 'Tirupathur', tirupattur: 'Tirupathur', sivagangai: 'Sivaganga', nellai: 'Tirunelveli',
  thirunelveli: 'Tirunelveli', mayiladuthurai: 'Mayiladuthurai', chengalpet: 'Chengalpattu',
};

export function normalizeDistrict(raw) {
  const k = String(raw || '').trim().toLowerCase();
  if (!k) return null;
  return DISTRICTS.find(d => d.toLowerCase() === k) || DISTRICT_ALIASES[k] || null;
}

export function normalizeMobile(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const ten = digits.length > 10 && (digits.startsWith('91') || digits.startsWith('0')) ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

// Registration-form fields: filled in by the nurse through their link; staff can correct them too.
// (Bank details are not here: only the nurse enters those.)
export const REG_FIELDS = ['email', 'address', 'taluk', 'block', 'qualification', 'council_reg_no', 'current_employment', 'experience_years', 'work_preference', 'preferred_locations', 'service_interests'];
export const REG_FIELD_LABELS = {
  email: 'Email', address: 'Address', taluk: 'Taluk', block: 'Block', qualification: 'Qualification', council_reg_no: 'Council reg. no.',
  current_employment: 'Current employment', experience_years: 'Experience (yrs)', work_preference: 'Work preference',
  preferred_locations: 'Preferred locations', service_interests: 'Service interests',
};
/** One registration field from a form: trimmed text (empty → null), experience as a number 0–60. Throws a message on bad input. */
export function cleanRegField(k, raw) {
  const v = raw == null ? null : String(raw).trim().slice(0, 1000) || null;
  if (k === 'experience_years') return v == null ? null : Math.max(0, Math.min(60, Number(v) || 0));
  if (k === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('Invalid email address');
  return v;
}
