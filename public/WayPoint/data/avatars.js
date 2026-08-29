// Waypoint — avatar palette (colours + animals).
//
// See claude/waypoint-companions-plan.md ("Companions & Avatars") for the
// full design. Short version: every ACCOUNT gets a self-picked coloured
// circle + animal face (e.g. green circle, penguin); every COMPANION who
// ISN'T linked to an account gets a fixed grey circle + a smiley in a
// colour the person who added them picked. The two looks are deliberately
// different so a marker tells you at a glance whether that person can log
// in — see resolveCompanionAvatars() in src/worker.js for exactly how a
// companion resolves to one or the other.
//
// Both lists below are the ACTUAL allowlist, not just an example: a
// colour or animal is only ever one of these tokens, both here and in
// src/worker.js's own copy (AVATAR_COLOR_TOKENS / AVATAR_ANIMAL_TOKENS —
// see the big comment there for why the Worker keeps its own copy rather
// than trusting anything the page sends). This file's job is turning a
// token into something a browser can actually show (a hex colour, an
// emoji) — never storing or accepting anything else. Never build a
// `style="background:..."` string straight from a value that came over
// the network (a stored companion/account record, an API response) —
// always look it up through avatarColorHex()/avatarAnimalEmoji() below
// first, so an unrecognised or tampered-with token can never end up
// inside a style attribute (see those two functions' own comments for
// why that specifically matters).
//
// Split out of index.html into its own file for the same reason as
// currencies.js/timezones.js/etc — see currencies.js's own comment for
// the full explanation. Loaded via <script src="/WayPoint/data/avatars.js">
// before the main inline script, so AVATAR_COLORS/AVATAR_ANIMALS are
// plain globals by the time the app code runs.

// 10 colours, chosen to be evenly spread around the colour wheel so any
// two are easy to tell apart at a glance, even for someone with mild
// colour-vision differences (the animal/smiley shape is always the real
// distinguishing feature though — see the "always pair with a name"
// accessibility note in renderAvatarMarker() in index.html; colour alone
// is never the only thing telling two people apart).
//
// Grey is deliberately NOT in this list — it's reserved as the fixed
// background for a companion who isn't linked to an account (see above),
// so it can never also be picked as an account's circle colour or a
// companion's smiley colour, which would make that marker ambiguous.
var AVATAR_COLORS = [
  { token: 'red', hex: '#EF4444' },
  { token: 'orange', hex: '#F97316' },
  { token: 'amber', hex: '#F59E0B' },
  { token: 'green', hex: '#22C55E' },
  { token: 'teal', hex: '#14B8A6' },
  { token: 'cyan', hex: '#06B6D4' },
  { token: 'blue', hex: '#3B82F6' },
  { token: 'indigo', hex: '#6366F1' },
  { token: 'purple', hex: '#A855F7' },
  { token: 'pink', hex: '#EC4899' }
];

// 16 animals, for the account-holder circle only (a companion without a
// login gets a smiley, never an animal — see above). Common, widely-
// supported emoji, chosen so every one renders as plain text (no custom
// icon assets needed) and stays visually distinct even at the small
// marker size used next to an item's name.
var AVATAR_ANIMALS = [
  { token: 'penguin', emoji: '🐧' },
  { token: 'lion', emoji: '🦁' },
  { token: 'fox', emoji: '🦊' },
  { token: 'owl', emoji: '🦉' },
  { token: 'panda', emoji: '🐼' },
  { token: 'koala', emoji: '🐨' },
  { token: 'tiger', emoji: '🐯' },
  { token: 'elephant', emoji: '🐘' },
  { token: 'giraffe', emoji: '🦒' },
  { token: 'rabbit', emoji: '🐰' },
  { token: 'bear', emoji: '🐻' },
  { token: 'wolf', emoji: '🐺' },
  { token: 'cat', emoji: '🐱' },
  { token: 'dog', emoji: '🐶' },
  { token: 'monkey', emoji: '🐵' },
  { token: 'dolphin', emoji: '🐬' }
];

// The fixed background colour for a companion with no account — never
// selectable, always this exact shade. Kept as one named constant rather
// than a literal '#9CA3AF' sprinkled around so every "grey background"
// reference in the app is guaranteed to mean the same shade.
var AVATAR_GREY_HEX = '#9CA3AF';

// Looks up a colour TOKEN (e.g. "green") and returns its hex code, or
// null if the token isn't one of the allowlisted ones above (a stale
// value from before a colour was retired, a corrupted record, or —
// worst case — a tampered-with request that got past the Worker's own
// validation somehow). Callers should always fall back to something safe
// (AVATAR_GREY_HEX, or just skip rendering a swatch) rather than ever
// putting the raw token into a style attribute directly — seeing this
// function return null is exactly what stops that.
function avatarColorHex(token) {
  var found = AVATAR_COLORS.find(function (c) { return c.token === token; });
  return found ? found.hex : null;
}

// Same idea as avatarColorHex() above, but for an animal token -> emoji.
function avatarAnimalEmoji(token) {
  var found = AVATAR_ANIMALS.find(function (a) { return a.token === token; });
  return found ? found.emoji : null;
}

// A stable "which colour/animal would this person get if they never
// picked one" fallback, so a marker never renders blank/undefined before
// someone opens the avatar picker (Phase 1) or before a non-account
// companion's adder picks a smiley colour. Deterministic from a seed
// string (an accountId or companionId) rather than random, so the same
// person/companion always gets the same default across renders and
// reloads, right up until they (or whoever added them) actually chooses
// one — at which point the real, saved value simply takes over.
//
// This is a simple, fast, non-cryptographic hash (it only ever needs to
// pick an array index, never anything security-sensitive — the real
// allowlist check always happens separately in avatarColorHex()/
// avatarAnimalEmoji() above and, server-side, in src/worker.js).
function deterministicAvatarIndex(seed, listLength) {
  var hash = 0;
  var text = String(seed || '');
  for (var i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0; // >>> 0 keeps it a positive 32-bit int.
  }
  return hash % listLength;
}
