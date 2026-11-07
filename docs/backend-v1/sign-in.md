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
| In-app account deletion | Built in iOS Settings. It needs the D1 backend, and refuses to run without it |
| Apple token revocation | Built, and off until the Apple key is set. Not yet tried with a real key |
| Apple credential checks in the app | Built, for sessions signed in with Apple on this build or later |

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
| `GET /account/deletion` | Signed in | What deleting this account would do: `{linkedSignIn,appleRevocation,blocked,tripsErased,tripsHandedOver,tripsLeft}` |
| `POST /account/deletion` | Signed in | `{confirm:"DELETE",appleAuthorizationCode?}`. Deletes the caller's own account and clears the cookie. Returns `{status:"ok",appleRevoked}` |

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

## Deleting an account

Anyone signed in to the iOS app can delete their own account from **Settings**.
Apple requires this (guideline 5.1.1(v)). The app shows what will happen, then
asks the person to type `DELETE`.

The server works in this order, so stopping at any point leaves the account in
place to try again:

1. It ends WayPoint's access to their Apple ID, if they confirmed with Apple.
2. It updates their trips and removes their access in D1.
3. It removes the account from KV, which ends all of its sessions at once.

The app removes that account's saved trips, drafts and session only after the
server confirms. If the reply is lost, trying again is safe: a genuine session
for an account that no longer exists is told the deletion worked.

`POST /account/deletion` responses:

| Status | Meaning |
| --- | --- |
| 200 | Deleted. `appleRevoked` says whether Apple's access ended |
| 400 | The confirmation or Apple code is missing or malformed |
| 401 | The session has ended, so nothing was deleted |
| 403 | The person confirmed with a different Apple ID, so nothing was deleted |
| 409 | This is the only site owner, nobody can take over a shared trip, or sharing changed while deleting. Only the last is worth retrying |
| 503 | D1 or KV failed, production is paused, or this server has no D1 backend |

### What happens to trips

| Trip | What happens |
| --- | --- |
| They own it, and no other account can open it | Erased, with its items, tags and grants. An empty row stays, because trip IDs are never reused |
| They own it, and other accounts can open it | It stays. Ownership passes to the longest-standing admin on the trip, otherwise to the site owner |
| Someone else owns it | Their access ends |

On every trip that stays, the participant entry linked to their account is
unlinked, renamed "Former traveller", and its notes are cleared. Items keep their
tags. Handed-over trips also lose their "Trip owner" tags, because that tag
follows whoever owns the trip and would otherwise move to the new owner.

Only an admin or the site owner can take a trip over, because both already see
all of it, so nobody sees anything new. A viewer or user is never promoted: they
see only the items tagged with them. A grant left behind by an account that no
longer exists doesn't keep a trip alive.

The only site owner account can't be deleted, matching Manage accounts. The app
shows how many trips fall into each row before the person confirms, and says that
shared trips stay.

**App Review risk.** Apple's account deletion page says deletion includes
"user-generated content that's shared with others". It doesn't address group data
that other people rely on. This rule keeps items the person may have written on
shared trips, with their identity removed. Erasing those trips instead would take
the itinerary from co-travellers, even during a trip, and would let anyone wipe a
shared trip by deleting their account.

Whether App Review accepts this is a judgement call that no test can settle. The
risk was seen and accepted when this rule was chosen over erasing every trip the
person owns. If review refuses it, that stricter rule is the fallback: it means
changing `deletionPlan` in `src/backend-v1/store.js` and the wording in the app.

### Ending Apple's access

The app asks Apple for a fresh authorization code at the moment of deletion. The
server exchanges that code for a token and revokes it straight away, using a
client secret it signs with the `.p8` key.

Apple's notes describe storing a token at sign-in. WayPoint doesn't, for three
reasons: no Apple credential sits in KV, `/login/identity` doesn't change so
older builds are unaffected, and accounts linked before this shipped can still be
revoked. An account stores only `{provider, sub, linkedAt}`, as before.

Apple says a deletion must go ahead even without a token, so revocation never
blocks one:

| What happens | Result |
| --- | --- |
| The person confirms with a different Apple ID | Nothing is deleted. They can try again, or delete without Apple |
| Apple refuses the code or revocation, or can't be reached | The account is deleted, with `appleRevoked:false` |
| The key isn't set | The app doesn't ask Apple. The account is deleted, with `appleRevoked:false` |
| The person chooses **Delete without Apple** | The account is deleted, with `appleRevoked:false` |

After any of the last three, the app tells the person how to remove WayPoint in
the Settings app. Failures are logged with Apple's error code and nothing else.

WayPoint holds no Google token, so a Google account has nothing to revoke.

The app also asks Apple at launch whether its link still stands, and listens for
Apple's revocation notice while running. A revoked link closes the session and
keeps drafts, the same as a session the server refuses. Any other answer leaves
the decision to the server. Sessions saved by older builds have no Apple
identifier and skip the check until the next sign-in.

## Worker variables

Set these in the Cloudflare dashboard. `wrangler.toml` has `keep_vars = true` and
no `[vars]` block. None of these are secrets.

| Variable | Value |
| --- | --- |
| `WAYPOINT_APPLE_CLIENT_IDS` | Services ID first, then the iOS bundle ID, separated by a comma |
| `WAYPOINT_GOOGLE_CLIENT_IDS` | Web client ID first, then the iOS client ID, separated by a comma |
| `WAYPOINT_PHONE_LOGIN` | Set to `off` at cutover. Leave unset until then |
| `WAYPOINT_APPLE_TEAM_ID` | Your 10-character Apple team ID |
| `WAYPOINT_APPLE_KEY_ID` | The Key ID of the Sign in with Apple key |

The key itself is a secret, and is only used to revoke Apple's access:

```bash
npx wrangler secret put WAYPOINT_APPLE_PRIVATE_KEY < AuthKey_XXXXXXXXXX.p8
```

Revocation stays off until all three are set and
`WAYPOINT_APPLE_CLIENT_IDS` lists the app's bundle ID second. Replacing the key
needs nothing else, because a client secret is signed fresh for each deletion.

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
4. Create a **Key** with Sign in with Apple enabled, and choose
   `com.liddellworks.waypoint` as its Primary App ID. Apple lets you download the
   `.p8` file only once. Keep it safe and never commit it. See
   [Worker variables](#worker-variables) for where it goes.

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
- **Delete account** is in Settings. It's hidden in the demo, and disabled until
  someone with an expired session signs in again.

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

With the Apple key set too, try these on a test account you can lose:

5. Delete an account from the app, confirming with Apple. WayPoint should leave
   the list in the Settings app under Sign-In & Security, then Sign in with Apple.
   Signing in again with that Apple ID should say it isn't linked.
6. Delete an account whose Apple ID was linked on the website, confirming in the
   app. Apple's list should clear in the same way. This is the check that a code
   from the app can end access granted through the website.
7. Start a deletion and confirm with a different Apple ID. Nothing should be
   deleted, and the app should say why.
8. Stop using Sign in with Apple for WayPoint in the Settings app, once with the
   app closed and once with it open. Each time, the session should close and
   drafts should survive signing back in.

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
  cannot be created or redeemed, sign-ins cannot be reset, and accounts cannot be
  deleted.
- **Account deletion can briefly lag.** KV takes up to about a minute to reach
  every Cloudflare location, so a session can work a little longer there. An
  account edit in Manage accounts in that same moment could bring the account
  back, without its trips.
- **Only the app can delete an account for now.** The website has no button, and
  the only site owner account can't be deleted at all.
- **Manage accounts still deletes only the account.** It leaves that person's
  trips, grants and Apple link in place.
- **Only linked participant entries are replaced.** A person's name typed into an
  unlinked participant entry, or into notes on a trip that stays, isn't searched
  for or removed.
- **Copies outside D1 outlive a deletion.** The old KV trips (`trip_index`,
  `trip:*`) stay in the live namespace after the move to D1, and the encrypted
  pre-migration backup has no automatic expiry. Both include anyone who later
  deletes their account.
