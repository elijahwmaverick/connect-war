# Connect War (Supabase online)

Online 1v1 Connect Four with abilities. No server code: the two players connect through Supabase Realtime, and the game page is a static site (GitHub Pages, free).

The **host's device runs the match** (rules, turn clock, hidden picks) and sends the board to the guest. The host has to keep the page open during the game. If the host's page closes, reopening the same link on the same device resumes the match.

## Files

- `index.html`: the page and styles
- `app.js`: online play (rooms, host logic, Supabase connection, board drawing)
- `game.js`: the rules engine (Tactics, plus shared board helpers)
- `rt.js`: the real-time Connect War rules
- `config.js`: your Supabase project URL and key (**edit this one**)

## 1. Supabase (free, about 3 minutes)

1. Go to https://supabase.com and create a new project. You can use the account from your Android project; any name and region work.
2. In the project, open **Project Settings → API** (or **API Keys**).
3. Copy the **Project URL** and the **anon** key (newer projects call it the **publishable** key).
4. Open `config.js` and paste them in:
   ```js
   SUPABASE_URL: "https://abcdefgh.supabase.co",
   SUPABASE_ANON_KEY: "eyJhbGciOi..."   // or sb_publishable_...
   ```

No tables or database setup are needed: the game only uses Realtime messages. The anon/publishable key is designed to be public, so it's fine in a public repo.

If you've turned on **Realtime → Settings → "Allow public access" = off** (private channels only), turn it back on for this project.

## 2. Put the page online with GitHub Pages (free)

1. Create a new **public** GitHub repository, for example `connect-war`.
2. Upload the five files (`index.html`, `app.js`, `game.js`, `config.js`, `README.md`) to it. Use **Add file → Upload files** on github.com, or push with git.
3. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: main / (root) → Save**.
4. After about a minute, the game is at `https://YOUR-NAME.github.io/connect-war/`.

## Game modes

- **Connect War** (default): real time, no turns. Drops have a 2.5s cooldown and each ability its own cooldown. Each four scores a point (those discs are removed). A four can be Contested: if the opponent makes a four within 0.25s, both cancel. First to 5, or the higher score after 5 minutes; a tie goes to sudden death with cooldowns cut to 1/4.
- **Connect War: Tactics**: turn based with energy. One four wins.

## 3. Play

1. Open the link and tap **Create game**. You're the host.
2. Send your opponent the 4-letter code, or tap **Copy link** and send the link.
3. Both pick 3 abilities (hidden until both lock in), then play.
4. After a match, both tap **Rematch** (same loadouts, other player goes first) or **New loadouts**.

## Test on one PC

Open the GitHub Pages link in a normal window and in a private/incognito window, then create in one and join from the other. (Opening `index.html` straight from your disk also works for testing.)

## Limits

- A free Supabase project **pauses after 7 days with no activity**. Unpause it from the Supabase dashboard (one click) and it works again.
- The host's copy of the game is the source of truth, so a host who edits the code could cheat. That's fine for friends. For public matchmaking later, the rules would move into a Supabase Edge Function.
