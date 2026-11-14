# Nurse messaging: SMS → WhatsApp → personal registration link

```
Staff SMS from their own phone ──▶ "… chat with us on WhatsApp: https://wa.me/91XXXXXXXXXX?text=Hi%20Uyir%20Team%2C%20I%20want%20to%20register.%20My%20code%3A%20UY7K3M9Q"
Nurse taps it ──▶ WhatsApp opens on our business chat with that text typed ──▶ the nurse taps Send
App receives it (webhook) ──▶ finds or creates the nurse ──▶ replies on WhatsApp with their personal registration link (once)
```

- **The nurse always sends first.** A wa.me link only pre-types the text; nothing is sent until the nurse taps Send. That message is their WhatsApp opt-in and opens Meta's 24-hour window, so the reply is free text (no template, no charge).
- **Matching:** by an `UY……` invite code in the message if there is one, else by the sender's number (a nurse's recorded WhatsApp number or mobile).
- **New sender:** if the number is an Indian mobile we don't know, the app creates a nurse record (source **WhatsApp**, status Invited, WhatsApp consent recorded) with their WhatsApp profile name and **no district**. The registration form asks for their full name and district; until then only Super Admins see the record ("No district yet"). Non-Indian numbers get a short reply saying an Indian number is needed.
- **Once per nurse:** the registration link is sent automatically only the first time. Later messages get no automatic reply; staff can resend from the nurse page. Meta's repeat deliveries of the same webhook are ignored, and two first messages arriving together still create one record and one reply (each message is handled in one transaction, under a row lock).
- **Do Not Contact:** no reply. The nurse page shows that they messaged us, so staff can lift Do Not Contact with their consent.
- Later updates (registration received, reminders, correction, rejected, verified) go on WhatsApp: free text within 24 hours of the nurse's last message, approved templates after that.

Until you configure it, `WHATSAPP_PROVIDER=simulated` records each message (staff see it under **Messages sent**) but sends nothing.

## 1. Meta setup (one time)

1. Create a **Meta Business** account and a **WhatsApp Business Account**, and add your business phone number. It must not be registered on the regular WhatsApp app.
2. In **developers.facebook.com**, create an app with the **WhatsApp** product and note the **Phone number ID**.
3. Create a **System User** with access to the WhatsApp account and generate a **permanent access token** with `whatsapp_business_messaging` permission.
4. In **WhatsApp Manager → Message templates**, create the templates below and wait until each shows **Approved**.
5. In the app's **WhatsApp → Configuration**, set the webhook to `https://uyirjobs.in/api/whatsapp/webhook`, enter your `WHATSAPP_VERIFY_TOKEN`, and subscribe to **messages**. This one webhook brings in the nurses' "Hi" messages **and** the delivered / read / failed receipts.

## 2. Templates

These are used outside the 24-hour window. Names and the number of `{{n}}` variables must match exactly. The wording can be changed, or translated to Tamil (`WHATSAPP_LANG=ta`), before you submit.

| Template name | Category | Body (submit this text) |
|---|---|---|
| `uyir_registration_link` | Utility | Vanakkam {{1}}, here is your personal Uyir registration link: {{2}}. Please do not share it. |
| `uyir_registration_received` | Utility | Thank you {{1}}, your Uyir registration is received. Please upload your documents here: {{2}} |
| `uyir_document_reminder` | Utility | Vanakkam {{1}}, please upload your nursing certificate, council registration and ID to complete your Uyir registration: {{2}} |
| `uyir_correction_required` | Utility | Vanakkam {{1}}, some of your documents need correction: {{2}}. Please re-upload them here: {{3}} |
| `uyir_registration_rejected` | Utility | Vanakkam {{1}}, we are unable to approve your Uyir registration at this time. Reason: {{2}} |
| `uyir_verified_add_bank` | Utility | Congratulations {{1}}! Your documents are verified. Please add your bank details for payments here: {{2}} |


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
