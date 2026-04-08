# ▶ YouTube For All

AI-powered YouTube growth platform. Upload your channel info, get everything you need — scripts, SEO, comments, viral series, collabs, and cross-platform posts.

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

## Deploy to Railway (DEV-LAMAR)

1. Push to GitHub (see below)
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add a PostgreSQL database (Railway provides free Postgres)
4. Set environment variables in Railway's Variables tab
5. Railway auto-deploys on every push ✅

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

---

## Deploy to Vercel

Vercel is for frontend only — this app has a Node.js backend. Use Railway for the full stack.

If you want a split setup:
- **Backend** → Railway
- **Frontend** → Update `fetch()` calls in `public/index.html` to point to your Railway URL

---

## Stripe Setup (optional)

1. Create products in [Stripe Dashboard](https://dashboard.stripe.com)
2. Create a "Pro" subscription price
3. Add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`, `STRIPE_PRO_PAYMENT_LINK` to `.env`
4. Set up webhook endpoint: `https://YOUR_DOMAIN/stripe/webhook`
   - Events to listen for: `checkout.session.completed`, `customer.subscription.deleted`

---

## File Structure

```
youtube_for_all/
├── server.js          ← Express API server
├── migrate.js         ← Database setup (run once)
├── package.json
├── .env.example       ← Copy to .env and fill in
├── .gitignore
├── README.md
└── public/
    └── index.html     ← Full frontend app
```

---

## Push to GitHub

```bash
cd youtube_for_all
git init
git add .
git commit -m "Initial commit — YouTube For All"
git remote add origin https://github.com/YOUR_USERNAME/youtube_for_all.git
git push -u origin main
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
