# Nurse messaging: SMS invite → WhatsApp

```
Staff send invite ──SMS──▶ "Vanakkam Meena, … Tap to chat with us on WhatsApp: https://wa.me/91XXXXXXXXXX?text=Hi%20Uyir%20UY7K3M9Q"
Nurse taps it ──▶ WhatsApp opens with "Hi Uyir UY7K3M9Q" typed ──▶ nurse sends it
App receives it (webhook) ──▶ matches the code to the nurse ──▶ replies on WhatsApp with their personal registration link
Everything after that is on WhatsApp: OTP, registration received, reminders, correction, rejected, verified.
```

- **SMS is used only for the invite** (and an invite reminder while the nurse hasn't messaged us yet). It carries the WhatsApp chat link, never the registration link.
- **The nurse's "Hi" is their WhatsApp opt-in.** The app records it, plus the number they messaged from, and sends all later WhatsApp messages to that number. Their WhatsApp number can differ from the mobile you have, because the code identifies them.
- **24-hour window:** for 24 hours after a nurse's last message, the app replies in free text (no template approval needed). After that, it uses approved templates.
- **Matching:** first by the `UY……` code in the message, else by the sender's number (their WhatsApp number or mobile). A nurse who was never invited but messages from their own mobile is invited quietly and gets the link. Unknown senders get: *"We could not find your Uyir registration…"*.
- **No spam:** Meta's repeated deliveries of the same message are ignored, and a burst of messages ("Hi", "hello", "?") gets one reply.
- **Do Not Contact:** no reply. The nurse page shows that they messaged us, so staff can lift Do Not Contact with their consent.
- **Staff "Resend":** goes by SMS (with the chat link) until the nurse has messaged us, then straight to WhatsApp with the registration link.
- Each nurse page shows **WhatsApp: connected / waiting for the nurse to say Hi**, their code and number. The list shows a **WA** badge, and the overview counts **Connected on WhatsApp**.

Until you configure it, `WHATSAPP_PROVIDER=simulated` records each message (staff see it under **Messages sent**) but sends nothing. SMS is also recorded as `simulated` until an SMS gateway is connected (see the end of this guide).

## 1. Meta setup (one time)

1. Create a **Meta Business** account and a **WhatsApp Business Account**, and add your business phone number. It must not be registered on the regular WhatsApp app.
2. In **developers.facebook.com**, create an app with the **WhatsApp** product and note the **Phone number ID**.
3. Create a **System User** with access to the WhatsApp account and generate a **permanent access token** with `whatsapp_business_messaging` permission.
4. In **WhatsApp Manager → Message templates**, create the templates below and wait until each shows **Approved**.
5. In the app's **WhatsApp → Configuration**, set the webhook to `https://uyirjobs.in/api/whatsapp/webhook`, enter your `WHATSAPP_VERIFY_TOKEN`, and subscribe to **messages**. This one webhook brings in the nurses' "Hi" messages **and** the delivered / read / failed receipts.

## 2. Templates

These are used outside the 24-hour window (and for the OTP). Names and the number of `{{n}}` variables must match exactly. The wording can be changed, or translated to Tamil (`WHATSAPP_LANG=ta`), before you submit.

| Template name | Category | Body (submit this text) |
|---|---|---|
| `uyir_registration_link` | Utility | Vanakkam {{1}}, here is your personal Uyir registration link: {{2}}. Please do not share it. |
| `uyir_registration_received` | Utility | Thank you {{1}}, your Uyir registration is received. Please upload your documents here: {{2}} |
| `uyir_document_reminder` | Utility | Vanakkam {{1}}, please upload your nursing certificate, council registration and ID to complete your Uyir registration: {{2}} |
| `uyir_correction_required` | Utility | Vanakkam {{1}}, some of your documents need correction: {{2}}. Please re-upload them here: {{3}} |
| `uyir_registration_rejected` | Utility | Vanakkam {{1}}, we are unable to approve your Uyir registration at this time. Reason: {{2}} |
| `uyir_verified_add_bank` | Utility | Congratulations {{1}}! Your documents are verified. Please add your bank details for payments here: {{2}} |
| `uyir_otp` | **Authentication** | Meta provides the wording ("{{1}} is your verification code…"). Choose the **Copy code** button and a 10-minute expiry. |

The OTP is sent immediately (not through the queue) and the code is **never stored**: the message record keeps `******`. If WhatsApp can't deliver it, the nurse sees an error and can try again straight away.

## 3. Configure the app

```
WHATSAPP_PROVIDER=meta
WHATSAPP_BUSINESS_NUMBER=91XXXXXXXXXX            # your WhatsApp Business number: the wa.me link in the SMS
WHATSAPP_TOKEN=<permanent system-user token>      # Secrets Manager in production
WHATSAPP_PHONE_NUMBER_ID=<phone number ID>
WHATSAPP_LANG=en                                  # language the templates were approved in
WHATSAPP_APP_SECRET=<Meta app secret>             # verifies webhook signatures (required in production)
WHATSAPP_VERIFY_TOKEN=<any random string>         # same value as in the Meta webhook setup
```

Restart the app. The startup line shows `WhatsApp: meta`.

## How sending works

- Messages are saved as **queued** in the same database transaction as the status change, so if the change fails, nothing goes out. A background worker in each app server sends them every few seconds; servers claim messages with `FOR UPDATE SKIP LOCKED`, so several servers never send one twice.
- Temporary errors (rate limits, Meta outages) are retried up to 5 times, with waits of 30 s, 2 min, 8 min and 32 min. Permanent errors (number not on WhatsApp, template not approved) are marked **failed**, with the error shown on the nurse page.
- Delivery receipts move each message to **sent → delivered → read** (or **failed**). The webhook is rejected unless it carries a valid `X-Hub-Signature-256` signature.
- Every incoming message is kept in `whatsapp_inbound` (sender, text, matched nurse, outcome) for audit.

## SMS gateway (for the invite)

The invite SMS is recorded as `simulated` until an SMS provider is connected. In India you need **DLT registration** (as a principal entity, with a sender ID and approved content templates) and a provider such as MSG91, Gupshup or Twilio. Register the two invite texts as DLT templates, with the variable parts (name, wa.me link) as `{#var#}`, and whitelist the `wa.me` URL.

## Costs and rules

- Conversations a nurse starts by messaging you (the "Hi") are free-text and cheaper than business-initiated ones. Utility and Authentication templates are billed per message; check current India rates in WhatsApp Manager.
- Keep the opt-in record: the "Hi" message, its time and number, and every consent change are in the nurse's history.
