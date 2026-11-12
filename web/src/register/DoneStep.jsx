const DONE = {
  SUBMITTED: ['Documents under review', () => 'Thank you! Our team is reviewing your documents. We will message you on WhatsApp once it is done.'],
  VERIFIED: ['Registration complete', () => 'Your documents are verified and your bank details are saved. Thank you for registering with Uyir.'],
  REJECTED: ['Registration not approved', n => `We are unable to approve your registration at this time.${n.review_note ? ' Reason: ' + n.review_note : ''} Please contact the Uyir team if you have questions.`],
};

export function DoneStep({ d, onEditPayout }) {
  const n = d.nurse, p = d.payout;
  const [title, text] = DONE[n.status] || [n.status_label, () => ''];
  return (
    <>
      <div className="muted mono small">{n.id}</div>
      <h1>{title}</h1>
      <p>{text(n)}</p>
      {p.on_file && (
        <p className="small muted">
          Payment details on file: {p.holder} · a/c ••••{p.last4} · {p.ifsc}
          {p.needed && <> · <button type="button" className="linkbtn" onClick={onEditPayout}>change</button></>}
        </p>
      )}
    </>
  );
}
