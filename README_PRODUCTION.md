# Production checklist — SHIVAM BOT BUILDER 3.1.0

1. Deploy the repository with the included Dockerfile and `render.yaml`.
2. Keep the Render persistent disk mounted at `/var/data` for the current SQLite/persistent-data architecture.
3. Set production secrets in Render Environment, not in source control.
4. Use a strong `BUILDER_SECRET` (32+ chars) and `BUILDER_ADMIN_KEY` (16+ chars).
5. `RENDER_EXTERNAL_URL` is used as the gateway callback base when `PUBLIC_BASE_URL` is not supplied.
6. Configure each seller bot's Payment Gateway with HTTPS API URL + API key only.
7. Run a real Telegram Bot API deployment test and a real gateway checkout/callback test after deployment.
8. Verify the health endpoint, bot heartbeat, automatic recovery, seller registration/login, product maintenance, product CRUD, stock, members, orders, broadcasts and payment history in the deployed environment.
9. Do not treat local/static checks as proof of live Render or gateway correctness; those require the real services.


## Seller Login: Google, Telegram and Password Reset

The seller login UI includes working OAuth redirect/callback routes and one-time password reset links. Configure these production secrets in Render; do not commit them to the repository.

### Google OAuth
1. Create a Google OAuth 2.0 **Web application** client.
2. Add the exact redirect URI: `https://YOUR-DOMAIN/api/auth/google/callback`.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

The server exchanges the authorization code server-side and retrieves the verified Google user profile before creating/linking the seller session.

### Telegram Login / OIDC
1. In `@BotFather`, configure the bot under Login Widget and register the website origin and callback URL.
2. Add `https://YOUR-DOMAIN/api/auth/telegram/callback` as an allowed redirect URI.
3. Set `TELEGRAM_CLIENT_ID` and `TELEGRAM_CLIENT_SECRET`.

The implementation uses authorization-code + PKCE and verifies the returned Telegram ID token against Telegram's JWKS before creating/linking the seller session.

### Password reset email
Configure SMTP:
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `MAIL_FROM`
- optional `PASSWORD_RESET_MINUTES` (10–120; default 30)

Reset tokens are random, stored only as SHA-256 hashes, expire automatically, are single-use, and revoke existing seller sessions after a successful password change.

### Important
The code is fully wired for these integrations, but OAuth/SMTP providers cannot issue real credentials from source code. The provider credentials must be entered as private Render environment variables for live sign-in/email delivery.
