# ▶ YouTube For All

AI-powered YouTube growth platform. Upload your channel info, get everything you need — scripts, SEO, comments, viral series, collabs, and cross-platform posts.

---

## 🌿 Branch Structure

This repo has two branches. Always check which one you're on before uploading or editing.

| Branch | Status | What's In It |
|--------|--------|--------------|
| `main` | ✅ Stable | Production-ready. The live app. Original dark theme (black / red / gold). |
| `beta` | 🧪 Beta | Active development. Theme switcher — toggle between Original and 🌊 Caribbean. |

### How to switch branches on GitHub
Click the **main** dropdown button at the top left of the file list → select `beta` to see beta files, `main` to see production files.

### How to switch branches locally
```bash
git checkout main    # stable production
git checkout beta    # beta / theme switcher
```

### Merging beta → main (when ready)
```bash
git checkout main
git merge beta
git push origin main
```

---

## 🎨 What's New in Beta

### Theme Switcher
- **Visual Style switcher** added to the sidebar bottom
- 🔴 **Original** — classic black / red / gold dark theme
- 🌊 **Caribbean** — deep ocean blue backgrounds with teal accents
- Theme choice saved to localStorage — persists across sessions
- Zero breaking changes — all features fully intact on both themes

---

## Features

- **Profile Setup** — Complete channel bio, keywords, banner brief, trailer script
- **Long-Form Video** — Full script, 3 title options, SEO description, thumbnail concept
- **Shorts & Reels** — Viral short-form scripts for YouTube Shorts, TikTok, Instagram
- **Comments Assistant** — Reply to comments, write strategic comments, comment strategy
- **Cross-Platform Posting** — Post across Twitter/X, Instagram, TikTok, Facebook, LinkedIn
- **Viral Series Generator** — AI designs series concepts engineered to go viral
- **Collaborations** — Invite creators for joint ventures, generate pitch emails
- **Free & Pro plans** via Stripe
- **BYO Anthropic key** — users can add their own key for unlimited access

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/YOUR_USERNAME/youtube_for_all.git
cd youtube_for_all
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your values
```

**Required:**
- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — 64 hex chars: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
- `ENCRYPTION_KEY` — exactly 64 hex chars: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `ANTHROPIC_API_KEY` — from [console.anthropic.com](https://console.anthropic.com)

### 3. Run Database Migration

```bash
npm run migrate
```

### 4. Start the App

```bash
npm run dev       # development (needs nodemon)
npm start         # production
```

Open [http://localhost:3000](http://localhost:3000)

---

## Deploy to Railway (Recommended)

1. Push to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add a PostgreSQL database (Railway provides free Postgres)
4. Set environment variables in Railway's Variables tab
5. Railway auto-deploys on every push to `main` ✅

**Railway env vars to set:**
```
DATABASE_URL        (Railway provides this automatically with Postgres)
JWT_SECRET          (generate as above)
ENCRYPTION_KEY      (generate as above)
ANTHROPIC_API_KEY   (your key)
FRONTEND_URL        (your Railway app URL, e.g. https://youtube-for-all.up.railway.app)
NODE_ENV            production
```

After first deploy, run the migration via Railway's shell:
```bash
node migrate.js
```

> ⚠️ Railway deploys from `main`. Keep `beta` as your dev branch and only merge to `main` when features are tested and ready.

---

## File Structure

```
youtube_for_all/
├── server.js          ← Express API server
├── migrate.js         ← Database setup (run once)
├── package.json
├── vercel.json
├── README.md
└── public/
    └── index.html     ← Full frontend (theme switcher lives here)
```

---

## Push Beta Branch to GitHub

```bash
# First time — create the beta branch
git checkout -b beta
git add .
git commit -m "Theme switcher — Beta 1"
git push origin beta

# Ongoing updates to beta
git checkout beta
git add .
git commit -m "Your update message"
git push origin beta
```

---

## Plans

| Feature              | Free | Pro    |
|---------------------|------|--------|
| Generations/month   | 15   | 500    |
| Channel profiles    | 1    | 10     |
| History depth       | 30   | 1,000  |
| All AI features     | ✅   | ✅     |
| BYO Anthropic key   | ✅   | ✅     |

---

*Built by Lamar Myers · VTREI LLC · YouTube For All*
