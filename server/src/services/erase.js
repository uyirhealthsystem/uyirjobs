// Deleting a nurse (Super Admin only). Personal data is erased everywhere it is kept: the nurse
// row, history notes, message texts, incoming WhatsApp messages, document rows and the files
// themselves (every S3 version). What stays is the nurse ID, status history (who changed what,
// when, without notes) and an entry saying who deleted the record, when and why.
//
// The database part is one transaction. Files are erased after it commits; if that fails, the
// record is still deleted and running Delete again retries the files.
import { q, one, tx } from '../db/pool.js';
import { httpError } from '../lib/errors.js';
import { logger } from '../logger.js';
import { logEvent } from './events.js';
import { purgeNurseFiles } from './storage.js';

const ERASE_COLUMNS = [
  'email', 'address', 'taluk', 'block', 'qualification', 'council_reg_no', 'current_employment', 'experience_years',
  'work_preference', 'preferred_locations', 'service_interests',
  'payout_account_holder', 'payout_account_enc', 'payout_account_last4', 'payout_ifsc', 'payout_upi', 'payout_added_at',
  'reg_token', 'reg_session', 'reg_session_expires', 'otp_hash', 'otp_expires', 'mobile_verified_at',
  'wa_code', 'whatsapp_number', 'review_note', 'source',
];

/** Returns { already, files_removed, files_pending }. */
export async function eraseNurse(id, user, reason) {
  const { drivers, already } = await tx(async () => {
    const n = await one(`SELECT id, deleted_at FROM nurses WHERE id = ? FOR UPDATE`, id);
    if (!n) throw httpError(404, 'Nurse not found');
    const drivers = (await q(`SELECT DISTINCT storage FROM documents WHERE nurse_id = ?`, id)).map(d => d.storage);
    if (n.deleted_at) return { drivers, already: true };   // retry: only the files below

    // mobile is NOT NULL UNIQUE: a placeholder that can never match a real number, so the person
    // can register again later as a new record.
    await q(`UPDATE nurses SET name = 'Deleted record', mobile = ?, ${ERASE_COLUMNS.map(c => `${c} = NULL`).join(', ')},
        consent_call = false, consent_sms = false, consent_whatsapp = false,
        dnc = true, dnc_reason = 'Record deleted', dnc_at = COALESCE(dnc_at, now()),
        deleted_at = now(), deleted_by = ?, deletion_reason = ?, updated_at = now()
      WHERE id = ?`, `deleted:${id}`, user.id, reason, id);
    await q(`UPDATE events SET note = NULL WHERE nurse_id = ?`, id);
    await q(`UPDATE messages SET body = '', payload = NULL, error = NULL,
        status = CASE WHEN status IN ('queued', 'sending') THEN 'cancelled' ELSE status END, updated_at = now()
      WHERE nurse_id = ?`, id);
    await q(`UPDATE whatsapp_inbound SET from_number = '', profile_name = NULL, body = NULL WHERE nurse_id = ?`, id);
    await q(`DELETE FROM documents WHERE nurse_id = ?`, id);
    await logEvent(id, 'note', { note: `Record deleted by ${user.name || user.username}: personal data and documents erased. Reason: ${reason}`, user });
    return { drivers, already: false };
  });

  try {
    const removed = await purgeNurseFiles(id, drivers);
    return { already, files_removed: removed, files_pending: false };
  } catch (e) {
    logger.error({ err: e, nurseId: id }, 'erasing nurse documents failed');
    await logEvent(id, 'note', { note: 'Documents could not be erased yet. Run Delete again to retry.', user });
    return { already, files_removed: 0, files_pending: true };
  }
}
