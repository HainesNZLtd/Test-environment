# Monthly Budget

A private web app that shows how much is left of the household's monthly groceries and miscellaneous budget, fed automatically from your bank and Amex.

It answers the question you'll actually ask at the supermarket: **how much have we got left, and are we on pace?**

## How it connects to the bank

NZ banks don't hand out API access to individuals, so the app reads your accounts through [Akahu](https://www.akahu.nz), New Zealand's open banking provider. You connect your bank and Amex to Akahu once, and the app reads transactions with a read-only personal token. Akahu personal apps are free for your own accounts.

1. Sign up at [my.akahu.nz](https://my.akahu.nz) and connect your bank(s) and American Express. Check Amex appears in Akahu's list of connections before committing to this approach.
2. Go to **Developers** and create a **personal app**. Copy the **App ID token** and the **User access token**.
3. Put them in the environment as `AKAHU_APP_TOKEN` and `AKAHU_USER_TOKEN` (see `.env.example`).

If you're sharing the budget with a partner who has their own accounts, both people connect to the same Akahu login.

Data is as fresh as Akahu's feed. Bank transactions usually land within hours; card and pending transactions can lag by up to a day. The refresh button asks Akahu to pull new data, and pending transactions are included so recent card spend isn't missed.

## What counts toward the budget

The maths is simple. Deciding what belongs in a "groceries and miscellaneous, nothing recurring" budget is the hard part. The app applies these rules in order, and the first match wins:

1. **Your call on that transaction**: tap it and choose count / don't count.
2. **Your merchant rules**: "always count Bunnings", "never count the school".
3. **Money in**: merchant refunds reduce spend. Salary and transfers in are ignored.
4. **Card repayments**: paying the Amex from the bank is excluded, otherwise every Amex purchase counts twice.
5. **Non-discretionary types**: transfers, direct debits, standing orders, bill payments, loans.
6. **Regular-bill categories**: housing, utilities, insurance (from Akahu's categorisation).
7. **Subscriptions**: anything that charged a near-identical amount in 2 of the last 3 months (Netflix, the gym). Variable spend like the supermarket is never caught by this.
8. **Everything else counts.**

Every transaction shows why it was or wasn't counted. Expect to make a handful of corrections in the first month, and very few after that, because merchant rules stick.

By default the app tracks everyday accounts and credit cards, not savings. Change this, the budget amount, and the month start day (set it to payday if that's how you think about the month) in Settings.

## Running it

Requires Node 22 or later. There are no npm dependencies.

```bash
npm run add-user -- jp        # create a login (repeat for your partner)
npm start                     # http://localhost:3000
npm run demo                  # try it on sample data without a bank connection
npm test
```

## Hosting

Any small host that runs Node or Docker with a persistent disk works. Fly.io, Railway or Render each cost a few dollars a month. A Dockerfile is included. Mount a volume at `/data`, set the Akahu tokens as secrets, set `PRODUCTION=1` and `TRUST_PROXY=1`, then create logins with `npm run add-user` on the server.

Add it to your phone's home screen and it behaves like an app.

## Security

- Bank access is **read-only**. The app can't move money.
- Akahu tokens live only in server environment variables. They never reach the browser.
- No transaction data is stored on disk. It's fetched from Akahu and held in memory for 10 minutes. The data file holds only logins (scrypt-hashed), sessions (stored hashed), and your settings.
- Sessions use HttpOnly, SameSite=Strict, Secure cookies. Login is rate limited per IP and per username.
- A strict Content Security Policy blocks inline scripts and framing, and bank-supplied text is never rendered as HTML.
- Use a long password (12 characters minimum is enforced). If you want a second factor, put the app behind Cloudflare Access or Tailscale. That's a stronger and cheaper option than building 2FA into the app.
