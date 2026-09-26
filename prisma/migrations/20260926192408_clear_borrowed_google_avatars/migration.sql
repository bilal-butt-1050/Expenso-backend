-- Data correction, no schema change.
--
-- The app's Settings screen used to fall back to the *phone's* Google session for an account with
-- no picture, and save that photo to the account. So a password account opened on a phone where
-- someone had used Google sign-in was permanently given their Google photo.
--
-- A password-only account (no googleId) has no legitimate way to get a Google photo: the server
-- only sets avatarUrl from Google for Google-linked accounts, and the app offers no way to enter a
-- URL. So such a picture can only have come from that bug. Clearing it makes the app fall back to
-- the account's own Gravatar. Google-linked accounts keep theirs (the server refreshes it at each
-- Google sign-in).
--
-- Idempotent: a second run matches nothing.
UPDATE "users"
SET "avatarUrl" = NULL
WHERE "googleId" IS NULL
  AND "avatarUrl" LIKE 'https://lh_.googleusercontent.com/%';
