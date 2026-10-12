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

- **Connect War** (default): turn based with energy (max 7) and a 20-second turn clock. One four wins. Supports **2 or 3 players**; 3-player games use a 10×8 board, turns go 1 → 2 → 3, and Freeze/Pop affect both opponents.
- **Connect War: Full Auto**: real time, no turns. You hold 3 drop charges (one recharges every 2.5s), each ability has its own cooldown, and every action starts a 0.15s global cooldown. Each four scores a point and turns into fixed stones that never move; a grenade destroys them, and a drop smashes the first fixed stone it lands on. A four can be Contested: if the opponent makes a four within 0.5s, neither scores. First to 5, or the higher score after 5 minutes; a tie goes to sudden death with cooldowns cut to 1/4.

Everyone picks a name on the main menu. Then play one of four ways: **Find match** (paired with the next player searching the same mode; 2-player only), **Host lobby** (name your lobby, or it defaults to *Name*'s Lobby), **Find lobby** (browse and join open lobbies), or **Play local** (everyone on one phone).

## 3. Play

1. Open the link, choose your name, and tap **Host lobby**. You're the host.
2. Your friends tap **Find lobby** and join your lobby from the list.
3. Both pick 3 abilities (hidden until both lock in), then play.
4. After a match, both tap **Rematch** (same loadouts, other player goes first) or **New loadouts**.

## Test on one PC

Open the GitHub Pages link in a normal window and in a private/incognito window, then create in one and join from the other. (Opening `index.html` straight from your disk also works for testing.)

## Limits

- A free Supabase project **pauses after 7 days with no activity**. Unpause it from the Supabase dashboard (one click) and it works again.
- The host's copy of the game is the source of truth, so a host who edits the code could cheat. That's fine for friends. For public matchmaking later, the rules would move into a Supabase Edge Function.
