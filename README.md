# Monthly Budget

A private, shared app for two people that tracks the household's monthly groceries and miscellaneous budget. Snap a photo of a receipt and the details fill themselves in, or type an entry by hand. It shows what's left, what you can spend per day for the rest of the month, and whether you're on pace.

Hosted on Netlify, with no other services to sign up for except an Anthropic API key for reading receipts.

## How it works

| Piece | What it does | Cost |
|---|---|---|
| Netlify site | Hosts the app and a single API function (`netlify/functions/api.mts`) | Within your existing Netlify plan |
| Netlify Identity | Email + password login, invite-only signup, password reset emails | Included |
| Netlify Blobs | Stores entries, settings and receipt photos | Included |
| Claude (Anthropic API) | Reads the receipt photo: store, date, total, groceries or misc | About 1 to 2 NZ cents per receipt |

Every receipt read is shown to you to check before it saves. If Claude can't read a receipt, the photo is still kept and you type the details in. Manual entry works with no API key at all.

## Setting it up (about 15 minutes)

1. **Create the site.** In Netlify, choose *Add new project → Import an existing project*, pick this GitHub repository and the branch you want to deploy. The build settings come from `netlify.toml`.
2. **Enable Identity.** Go to *Project configuration → Identity → Enable Identity*. Then:
   - *Registration → Registration preferences*: set to **Invite only**. Nobody can sign up uninvited.
   - Leave external providers (Google etc.) off.
3. **Set environment variables** under *Project configuration → Environment variables*, scoped to Functions:
   - `ANTHROPIC_API_KEY`: from [console.anthropic.com](https://console.anthropic.com). Put a monthly spend limit on it there; NZ$5 is generous for a household.
   - `ALLOWED_EMAILS`: the two email addresses, comma separated. This is a second lock behind invite-only.
4. **Redeploy** so the functions pick up the variables.
5. **Invite both people.** *Identity → Invite users*, enter both email addresses. Each person gets an email, taps the link, chooses a password and is in.
6. On each phone, open the site and use **Share → Add to Home Screen**, so it behaves like an app.

**Forgotten password:** tap *Forgot password?* on the sign-in screen, and a reset link is emailed. Emails come from `no-reply@netlify.com`, so check spam the first time.

## Using it

- **Snap a receipt** opens the camera. The app shrinks the photo, Claude reads it, and you check the amount and tap Save.
- **Add manually** for anything without a receipt. Use a minus amount for a refund.
- Tap any entry to edit or delete it. Deleting an entry also deletes its receipt photo.
- The arrows at the top step back through previous months.
- **Settings** changes the budget amount and the day the month starts (set it to payday if that's how you think about the month).

## Development

```bash
npm install
npm test          # budget logic and the full API against an in-memory store
npm run build     # bundles src/app.js into public/app.js
```

Netlify Identity doesn't run locally under `netlify dev`, so test sign-in on a deploy preview.

## Security notes

- Signup is invite-only, and the API also checks every request against `ALLOWED_EMAILS`.
- Receipt photos and entries are only served to signed-in, allowlisted users.
- A strict Content Security Policy blocks third-party scripts and framing. Netlify Identity keeps the session in a cookie that page scripts can read, which is why no third-party code is allowed on the page.
- The Anthropic key lives only in Netlify's server-side environment and never reaches the browser.
