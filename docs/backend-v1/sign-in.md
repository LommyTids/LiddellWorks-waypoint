# Sign in with Apple and Google

WayPoint is moving from phone-number login to Apple and Google. Apple or Google
proves who someone is. WayPoint still decides who may come in: a provider
identity works only after it is linked to an existing account, and only an
owner-issued invite can link one.

## What exists today

| Part | State |
| --- | --- |
| Token checks, invites, phone switch, ending sessions | Built, and off until client IDs are set |
| Owner phone login | **Refused now**, whatever the settings |
| Owner password page at `/waypoint/#owner-login` | Built |
| Apple and Google buttons on the website | Built, and hidden until client IDs are set |
| Invite and Reset sign-in in Manage accounts | Built, and hidden until client IDs are set |
| Apple and Google sign-in in the iOS app | Built, and hidden until the app client IDs are set. Not yet tried with a real Apple or Google account |
| In-app account deletion and Apple token revocation | Not built; required before App Store review |

## Approving someone

1. In Manage accounts, add an account for them if they don't have one.
2. Choose **Invite** on their account and copy the link. It works once and lasts
   seven days. Creating another invite cancels the last one.
3. Send it to them privately. They open it and sign in with Apple or Google.

Their account then shows which provider it uses. To approve yourself, create an
invite for your own account, log out, and open the link. If you open it while
signed in, it waits in that tab until you log out.

The token is in the link's fragment (`#invite=…`), which browsers never send to a
server or another site. The page removes it from the address bar straight away.

## Routes

All paths start at `/WayPoint/api`.

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /login/config` | Anyone | `{providers:{apple:{clientId,nativeClientId},google:{clientId,nativeClientId}},phoneLogin}`, listing only configured providers. `nativeClientId` is `null` until a second ID is set |
| `GET /login/nonce` | Anyone | `{nonce}`, valid for ten minutes. Pass it unchanged to Apple or Google, which sign it into the token |
| `POST /login/identity` | Anyone | `{provider,idToken,invite?}`. Returns the same body and cookie as `/login` |
| `POST /invites` | Owner | `{accountId}`. Returns `{invite,accountId,username,expiresAt}`. Valid for seven days |
| `POST /identities/reset` | Owner | `{accountId}`. Removes the linked sign-in and any unused invite, and ends the account's sessions |
| `POST /sessions/end-all` | Owner | `{}`. Ends every session, then returns a new one for the caller |

`/login/identity` responses:

| Status | Meaning |
| --- | --- |
| 200 | Signed in |
| 401 | The token or nonce failed a check |
| 403 | The identity is not linked, or the invite has expired or been used |
| 404 | That provider is not configured |
| 409 | The identity belongs to another account, or the account already has a sign-in |
| 429 | Too many attempts from this address |
| 503 | Provider keys are unreachable, or linking was tried while production is paused |

## Changing a linked sign-in

Each account has one linked sign-in. An invite cannot add a second one, so a
forwarded invite can't let a stranger into an account that is already set up.

When someone loses their Apple ID or wants to switch provider:

1. Choose **Reset sign-in** on their account in Manage accounts.
2. Choose **Invite** and send them the new link.

The reset signs that person out everywhere. Their phone hides its saved trips
until they sign in again, and their drafts stay on the device. If you reset your
own account, sign back in at `/waypoint/#owner-login`.

## Worker variables

Set these in the Cloudflare dashboard. `wrangler.toml` has `keep_vars = true` and
no `[vars]` block. None of them are secrets.

| Variable | Value |
| --- | --- |
| `WAYPOINT_APPLE_CLIENT_IDS` | Services ID first, then the iOS bundle ID, separated by a comma |
| `WAYPOINT_GOOGLE_CLIENT_IDS` | Web client ID first, then the iOS client ID, separated by a comma |
| `WAYPOINT_PHONE_LOGIN` | Set to `off` at cutover. Leave unset until then |

The first ID in each list is the one the website uses. The second is the app's,
and the app shows a provider's button only when that second ID is set.

Setting `WAYPOINT_GOOGLE_CLIENT_IDS` also changes the page's `Referrer-Policy`
from `no-referrer` to `strict-origin-when-cross-origin`, because Google's button
needs to see the site's origin. Other sites the page loads from then see
`https://liddellworks.com` as well, but never the path.

## Apple setup

This needs a paid Apple Developer Program membership. Console names may differ
slightly from these.

1. In Certificates, Identifiers & Profiles, open the App ID
   `com.liddellworks.waypoint` and enable **Sign in with Apple**.
2. Create a **Services ID**, for example `com.liddellworks.waypoint.web`. This is
   the website's client ID.
3. Enable Sign in with Apple on the Services ID and choose **Configure**:
   - Primary App ID: `com.liddellworks.waypoint`
   - Domains: `liddellworks.com`
   - Return URL: `https://liddellworks.com/waypoint/`

   The Primary App ID must be the app. That is what gives one person the same
   Apple identifier on the website and in the app.
4. Before account deletion is built, create a **Key** with Sign in with Apple
   enabled. Keep the `.p8` file safe and never commit it. It will be a Worker
   secret, and is only needed for token revocation.

The website uses Apple's popup flow (`usePopup: true`). The redirect flow posts a
form from Apple's site, which the Worker rejects as a cross-site write. Apple
refuses localhost and IP addresses, so try it on the real domain.

## Google setup

1. In Google Cloud Console, create a project and open **Google Auth Platform**.
2. Fill in Branding, and set Audience to **External**. Only the `openid` and
   `email` scopes are needed. Google asks for one beside `openid`, and WayPoint
   reads neither.
3. Create a **Web application** client with the authorized JavaScript origin
   `https://liddellworks.com`.
4. Create an **iOS** client with bundle ID `com.liddellworks.waypoint`.
5. Publish the app so it is not limited to test users.

## The iOS app

- **Apple** uses the system sign-in sheet and asks for no name or email. The
  button's request can't wait for the network, so the screen fetches a nonce when
  it opens and replaces it every nine minutes.
- **Google** uses the system browser with the authorization code flow and PKCE.
  There is no Google SDK and no client secret. The app fetches a nonce at the tap,
  checks `state` on the redirect, and exchanges the code at
  `oauth2.googleapis.com`. That is the only host besides WayPoint that the app
  calls. It keeps the ID token just long enough to send it to WayPoint, and drops
  the access token.
- **Invites are redeemed on the website.** The app has no invite step. Someone
  new opens their link in Safari, signs in there, then signs in to the app with
  the same Apple or Google account.
- **The phone form** stays until `/login/config` says `phoneLogin:false`. It also
  shows whenever that route can't be reached, so a server without these routes
  behaves as it did before.

The app has the Sign in with Apple entitlement in
`apps/ios/WayPointApp/WayPoint.entitlements`. With automatic signing, Xcode needs
to be signed in to the team, and the App ID needs the capability from step 1 of
Apple setup. Simulator builds don't need either.

### Checks only a real account can do

The automated tests use stand-ins for Apple and Google. Before step 5 of the
cutover, try these with the client IDs set, on a physical iPhone:

1. Sign in with Apple on an unlinked Apple ID. The app should say it isn't linked.
2. Redeem an invite in Safari with Apple, then sign in to the app with the same
   Apple ID. The account should open.
3. Do the same with Google, and confirm Google's page returns to the app.
4. Cancel each one partway. The app should say nothing and stay on the sign-in
   screen.

## Cutover order

The order matters, because each step removes a way back in.

1. **Before deploying this code**, sign in as the owner and use Manage accounts
   to set a password you know on your own account. Owner phone login stops the
   moment this code deploys, and the password page is then the only way in.
   Setting a password ends your current session.
2. Deploy, then confirm `/waypoint/#owner-login` works.
   The iOS app has no password screen, so if the owner signs out there they
   cannot sign back in until step 4 ships. Their current session keeps working.
3. Complete the Apple and Google setup, and set the two client ID variables.
4. Ship the iOS build with sign-in. Older installed apps can only use phone
   login, so this must reach people before step 6.
5. Invite every account, including your own, and check that everyone can sign in.
6. Set `WAYPOINT_PHONE_LOGIN` to `off`.
7. Call `POST /sessions/end-all` with `{}`, from the browser console while signed
   in as the owner. Without this, any session made through a guessed number keeps
   renewing.

Step 7 signs everyone out. A phone that is online then hides its saved trips
until that person signs in again. Their drafts stay on the device.

**Do not rotate `WAYPOINT_SESSION_SECRET` to end sessions.** It also signs sync
cursors, and installed apps get stuck on `400 invalid_cursor` when it changes.

## Known limits

- **Password login stays open.** It is rate limited but cannot be switched off,
  and it still works for any account that has a password.
- **Invites are one-time on a best-effort basis.** Accounts live in one KV
  document with no transactions, so two people redeeming the same invite within
  moments could both succeed, and concurrent account edits can overwrite each
  other. Send invites directly to the person, and create a new one to withdraw
  an invite.
- **A token can be replayed until its nonce expires.** Nonces are signed rather
  than stored, so sign-in keeps working while KV is read-only. A replay reaches
  only the account the token already belongs to.
- **While production is paused**, linked identities can sign in, but invites
  cannot be created or redeemed, and sign-ins cannot be reset.
