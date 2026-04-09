/**
 * youtube_for_all — server.js
 * AI-powered YouTube growth platform
 */
"use strict";

const express  = require("express");
const helmet   = require("helmet");
const cors     = require("cors");
const bcrypt   = require("bcrypt");
const jwt      = require("jsonwebtoken");
const { Pool } = require("pg");
const crypto   = require("crypto");
const Stripe   = require("stripe");
const path     = require("path");

// ── Env checks ────────────────────────────────────────────────────────────────
const REQUIRED_ENV = ["DATABASE_URL", "JWT_SECRET", "ENCRYPTION_KEY"];
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) { console.error(`FATAL: missing env var ${k}`); process.exit(1); }
}
if (process.env.ENCRYPTION_KEY.length !== 64) {
  console.error("FATAL: ENCRYPTION_KEY must be 64 hex chars. Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  process.exit(1);
}

// ── Constants ─────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const JWT_SECRET    = process.env.JWT_SECRET;
const ENC_KEY       = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_HOOK   = process.env.STRIPE_WEBHOOK_SECRET;

const PLAN_LIMITS = {
  free: { generations: 15,  profiles: 1,  history: 30  },
  pro:  { generations: 500, profiles: 10, history: 1000 },
};

// ── App & DB ─────────────────────────────────────────────────────────────────
const app    = express();
const pool   = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET, { apiVersion: "2024-04-10" }) : null;

// Stripe webhook needs raw body — BEFORE express.json()
app.use("/stripe/webhook", express.raw({ type: "application/json" }));

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || "*", credentials: true }));
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Helpers ───────────────────────────────────────────────────────────────────
const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function encrypt(text) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const enc    = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}
function decrypt(payload) {
  const [ivHex, tagHex, encHex] = payload.split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, Buffer.from(ivHex, "hex"));
  d.setAuthTag(Buffer.from(tagHex, "hex"));
  return d.update(Buffer.from(encHex, "hex"), undefined, "utf8") + d.final("utf8");
}

function authMW(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Invalid or expired token" }); }
}

async function getAnthropicKey(userId) {
  const { rows } = await pool.query("SELECT anthropic_key_enc FROM users WHERE id=$1", [userId]);
  let key = process.env.ANTHROPIC_API_KEY;
  if (rows[0]?.anthropic_key_enc) {
    try { key = decrypt(rows[0].anthropic_key_enc); } catch {}
  }
  return key;
}

async function callClaude(apiKey, systemPrompt, userPrompt, maxTokens = 2000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || "Anthropic API error");
  }
  const data = await res.json();
  return data.content?.find(b => b.type === "text")?.text || "";
}

async function usageThisMonth(userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM generations WHERE user_id=$1 AND created_at >= date_trunc('month',now())`,
    [userId]
  );
  return parseInt(rows[0]?.cnt || "0", 10);
}

async function checkLimit(userId, plan) {
  const limit = PLAN_LIMITS[plan || "free"].generations;
  const used  = await usageThisMonth(userId);
  if (used >= limit) throw { status: 429, message: `Monthly limit of ${limit} reached. Upgrade to Pro for more.` };
  return used;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════

app.post("/auth/register", asyncH(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  if (password.length < 8)  return res.status(400).json({ error: "Password must be ≥ 8 chars" });

  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, plan, created_at)
     VALUES ($1,$2,'free',now()) ON CONFLICT (email) DO NOTHING
     RETURNING id, email, plan, is_admin`,
    [email.toLowerCase().trim(), hash]
  );
  if (!rows.length) return res.status(409).json({ error: "Email already registered" });

  const token = jwt.sign(
    { id: rows[0].id, email: rows[0].email, plan: rows[0].plan, is_admin: rows[0].is_admin },
    JWT_SECRET, { expiresIn: "30d" }
  );
  res.json({ token, user: rows[0] });
}));

app.post("/auth/login", asyncH(async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query("SELECT * FROM users WHERE email=$1", [email?.toLowerCase().trim()]);
  if (!rows.length) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, rows[0].password_hash);
  if (!ok)  return res.status(401).json({ error: "Invalid credentials" });

  const u     = rows[0];
  const token = jwt.sign({ id: u.id, email: u.email, plan: u.plan, is_admin: u.is_admin }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: { id: u.id, email: u.email, plan: u.plan, is_admin: u.is_admin } });
}));

// ── API Key ───────────────────────────────────────────────────────────────────
app.post("/settings/api-key", authMW, asyncH(async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey?.startsWith("sk-ant-")) return res.status(400).json({ error: "Key must start with sk-ant-" });
  await pool.query("UPDATE users SET anthropic_key_enc=$1 WHERE id=$2", [encrypt(apiKey), req.user.id]);
  res.json({ ok: true });
}));
app.delete("/settings/api-key", authMW, asyncH(async (req, res) => {
  await pool.query("UPDATE users SET anthropic_key_enc=NULL WHERE id=$1", [req.user.id]);
  res.json({ ok: true });
}));
app.get("/settings/api-key", authMW, asyncH(async (req, res) => {
  const { rows } = await pool.query("SELECT anthropic_key_enc FROM users WHERE id=$1", [req.user.id]);
  res.json({ hasKey: !!rows[0]?.anthropic_key_enc });
}));

// ── Usage ─────────────────────────────────────────────────────────────────────
app.get("/usage", authMW, asyncH(async (req, res) => {
  const plan  = req.user.plan || "free";
  const limit = PLAN_LIMITS[plan].generations;
  const used  = await usageThisMonth(req.user.id);
  res.json({ used, limit, plan });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// CHANNEL PROFILES
// ═══════════════════════════════════════════════════════════════════════════════

app.get("/profiles", authMW, asyncH(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM channel_profiles WHERE user_id=$1 ORDER BY created_at DESC",
    [req.user.id]
  );
  res.json(rows);
}));

app.post("/profiles", authMW, asyncH(async (req, res) => {
  const plan  = req.user.plan || "free";
  const limit = PLAN_LIMITS[plan].profiles;
  const { rows: cnt } = await pool.query("SELECT COUNT(*) AS c FROM channel_profiles WHERE user_id=$1", [req.user.id]);
  if (parseInt(cnt[0].c, 10) >= limit)
    return res.status(403).json({ error: `Profile limit (${limit}) reached for ${plan} plan` });

  const { channel_name, niche, target_audience, avatar_style, tone, posting_freq, extra_context } = req.body;
  if (!channel_name) return res.status(400).json({ error: "channel_name required" });

  const { rows } = await pool.query(
    `INSERT INTO channel_profiles (user_id,channel_name,niche,target_audience,avatar_style,tone,posting_freq,extra_context,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now()) RETURNING *`,
    [req.user.id, channel_name, niche||null, target_audience||null, avatar_style||"avatar_heavy", tone||"friendly", posting_freq||"weekly", extra_context||null]
  );
  res.json(rows[0]);
}));

app.put("/profiles/:id", authMW, asyncH(async (req, res) => {
  const fields = ["channel_name","niche","target_audience","avatar_style","tone","posting_freq","extra_context"];
  const sets   = fields.map((f, i) => `${f}=COALESCE($${i+1},${f})`).join(",");
  const vals   = fields.map(f => req.body[f] ?? null);
  const { rows } = await pool.query(
    `UPDATE channel_profiles SET ${sets}, updated_at=now() WHERE id=$${fields.length+1} AND user_id=$${fields.length+2} RETURNING *`,
    [...vals, req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Profile not found" });
  res.json(rows[0]);
}));

app.delete("/profiles/:id", authMW, asyncH(async (req, res) => {
  await pool.query("DELETE FROM channel_profiles WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// AI GENERATION — YOUTUBE PROFILE SETUP
// ═══════════════════════════════════════════════════════════════════════════════

app.post("/generate/profile-setup", authMW, asyncH(async (req, res) => {
  const plan  = req.user.plan || "free";
  await checkLimit(req.user.id, plan);

  const apiKey = await getAnthropicKey(req.user.id);
  if (!apiKey) return res.status(400).json({ error: "No Anthropic API key configured" });

  const { profileId } = req.body;
  const { rows: p } = await pool.query("SELECT * FROM channel_profiles WHERE id=$1 AND user_id=$2", [profileId, req.user.id]);
  if (!p.length) return res.status(404).json({ error: "Profile not found" });
  const profile = p[0];

  const system = `You are a YouTube growth expert. You help creators build their complete YouTube presence from scratch. 
Always be specific, actionable, and enthusiastic. Structure your output clearly with sections.`;

  const prompt = `Create a complete YouTube channel setup guide for:
- Channel Name: ${profile.channel_name}
- Niche: ${profile.niche || "not specified"}
- Target Audience: ${profile.target_audience || "not specified"}
- Content Style: ${profile.avatar_style === "avatar_heavy" ? "Avatar/animated heavy" : "Face-forward"}
- Tone: ${profile.tone}
- Posting Frequency: ${profile.posting_freq}
${profile.extra_context ? `- Additional Context: ${profile.extra_context}` : ""}

Please provide:
1. **Channel Description** (2 versions: short 150 chars for about section, long 1000 chars)
2. **Channel Keywords** (15-20 SEO keywords)
3. **Channel Art Brief** (what to put on banner, color palette suggestion)
4. **Profile Picture Brief** (what it should look like for this niche)
5. **First 5 Video Ideas** (title, hook, thumbnail concept)
6. **Channel Trailer Script** (60 seconds)
7. **Social Media Bio** (Twitter/X, Instagram, TikTok versions)`;

  const result = await callClaude(apiKey, system, prompt, 3000);

  await pool.query(
    "INSERT INTO generations (user_id,profile_id,type,prompt,result,created_at) VALUES ($1,$2,$3,$4,$5,now())",
    [req.user.id, profileId, "profile_setup", "profile_setup", result.slice(0,3000)]
  );

  res.json({ result });
}));

// ── Long-form Video ───────────────────────────────────────────────────────────
app.post("/generate/long-form", authMW, asyncH(async (req, res) => {
  await checkLimit(req.user.id, req.user.plan);

  const apiKey = await getAnthropicKey(req.user.id);
  if (!apiKey) return res.status(400).json({ error: "No Anthropic API key configured" });

  const { profileId, topic, duration } = req.body;
  if (!topic) return res.status(400).json({ error: "topic required" });

  let profileCtx = "";
  if (profileId) {
    const { rows: p } = await pool.query("SELECT * FROM channel_profiles WHERE id=$1 AND user_id=$2", [profileId, req.user.id]);
    if (p[0]) profileCtx = `Channel: ${p[0].channel_name}, Niche: ${p[0].niche}, Tone: ${p[0].tone}`;
  }

  const system = `You are an expert YouTube scriptwriter and video strategist. Create compelling, watch-time-maximizing content.`;

  const prompt = `Create a complete long-form YouTube video package for topic: "${topic}"
${profileCtx ? `Channel context: ${profileCtx}` : ""}
Target duration: ${duration || "10-15 minutes"}

Provide:
1. **Optimized Title** (3 variations — curiosity gap, listicle, and how-to styles)
2. **SEO Description** (first 150 chars are critical — hooks the search click, then full 500-word description with keywords)
3. **Tags** (20 tags, mix of broad and specific)
4. **Thumbnail Concept** (colors, text overlay, image suggestion, emotion to convey)
5. **Hook Script** (first 30 seconds — must stop the scroll)
6. **Full Video Outline** with timestamps
7. **Full Script** (engaging, natural, with [B-ROLL] and [CUT TO] markers)
8. **End Screen CTA Script**
9. **Comment Pinning Strategy** (what to pin and say to boost engagement)`;

  const result = await callClaude(apiKey, system, prompt, 4000);

  await pool.query(
    "INSERT INTO generations (user_id,profile_id,type,prompt,result,created_at) VALUES ($1,$2,$3,$4,$5,now())",
    [req.user.id, profileId||null, "long_form", topic.slice(0,500), result.slice(0,3000)]
  );

  res.json({ result });
}));

// ── Short-form / Shorts ───────────────────────────────────────────────────────
app.post("/generate/short-form", authMW, asyncH(async (req, res) => {
  await checkLimit(req.user.id, req.user.plan);

  const apiKey = await getAnthropicKey(req.user.id);
  if (!apiKey) return res.status(400).json({ error: "No Anthropic API key configured" });

  const { profileId, topic, count } = req.body;
  if (!topic) return res.status(400).json({ error: "topic required" });

  let profileCtx = "";
  if (profileId) {
    const { rows: p } = await pool.query("SELECT * FROM channel_profiles WHERE id=$1 AND user_id=$2", [profileId, req.user.id]);
    if (p[0]) profileCtx = `Channel: ${p[0].channel_name}, Niche: ${p[0].niche}, Tone: ${p[0].tone}`;
  }

  const system = `You are a viral short-form video expert specializing in YouTube Shorts, TikTok, and Reels. You understand the algorithm and what makes people watch to the end.`;

  const prompt = `Create ${count || 5} viral YouTube Shorts scripts for topic: "${topic}"
${profileCtx ? `Channel context: ${profileCtx}` : ""}

For EACH Short provide:
1. **Hook** (first 3 seconds — text on screen + voiceover)
2. **Script** (max 60 seconds, punchy, every second counts)
3. **Visual Direction** (what to show each 5-10 seconds)
4. **On-screen text overlays**
5. **Sound/Music suggestion**
6. **Caption/Title for posting**
7. **Hashtags** (5 targeted)
8. **Best time to post**
9. **Cross-platform adaptation** (TikTok tweak, Reels tweak)`;

  const result = await callClaude(apiKey, system, prompt, 4000);

  await pool.query(
    "INSERT INTO generations (user_id,profile_id,type,prompt,result,created_at) VALUES ($1,$2,$3,$4,$5,now())",
    [req.user.id, profileId||null, "short_form", topic.slice(0,500), result.slice(0,3000)]
  );

  res.json({ result });
}));

// ── Comments Assistant ────────────────────────────────────────────────────────
app.post("/generate/comments", authMW, asyncH(async (req, res) => {
  await checkLimit(req.user.id, req.user.plan);

  const apiKey = await getAnthropicKey(req.user.id);
  if (!apiKey) return res.status(400).json({ error: "No Anthropic API key configured" });

  const { profileId, mode, comments, videoTopic } = req.body;
  // mode: "reply_batch" | "write_new" | "strategy"
  if (!mode) return res.status(400).json({ error: "mode required" });

  let profileCtx = "";
  if (profileId) {
    const { rows: p } = await pool.query("SELECT * FROM channel_profiles WHERE id=$1 AND user_id=$2", [profileId, req.user.id]);
    if (p[0]) profileCtx = `Channel: ${p[0].channel_name}, Tone: ${p[0].tone}, Niche: ${p[0].niche}`;
  }

  const system = `You are a YouTube community management expert. You help creators build engaged communities through authentic, strategic commenting. You understand that comments are a key ranking signal.`;

  let prompt = "";
  if (mode === "reply_batch") {
    prompt = `Write authentic, engaging replies for these YouTube comments on a video about "${videoTopic || "the topic"}":
${profileCtx ? `Creator context: ${profileCtx}` : ""}

Comments to reply to:
${(comments || []).map((c, i) => `${i+1}. "${c}"`).join("\n")}

For each comment:
- Write a reply that feels genuine (not robotic)
- Encourage further engagement
- Sometimes ask a follow-up question
- Match the creator's tone
- Keep replies 1-3 sentences (authentic length)`;
  } else if (mode === "write_new") {
    prompt = `Write 10 strategic comments I should post on other creators' videos in my niche to grow my channel.
${profileCtx ? `My channel: ${profileCtx}` : ""}
Niche/Topic: ${videoTopic || "general"}

Each comment should:
- Add genuine value to the conversation
- Subtly position me as an authority
- Be interesting enough that people click my profile
- Never be spammy or promotional
- Vary in length and style`;
  } else {
    prompt = `Create a complete YouTube comments strategy for a creator.
${profileCtx ? `Channel: ${profileCtx}` : ""}
Video topic: ${videoTopic || "general content"}

Include:
1. **Pinned Comment Template** (what to pin to boost engagement)
2. **Heart Comment Strategy** (which comments to heart and why)
3. **Reply Templates** (for common comment types: praise, questions, criticism, spam)
4. **Community Tab Post Ideas** (5 post ideas to drive channel engagement)
5. **Comment Timing** (when to reply for maximum visibility)
6. **Algorithm Tips** (how comments affect your ranking)`;
  }

  const result = await callClaude(apiKey, system, prompt, 3000);

  await pool.query(
    "INSERT INTO generations (user_id,profile_id,type,prompt,result,created_at) VALUES ($1,$2,$3,$4,$5,now())",
    [req.user.id, profileId||null, "comments", mode, result.slice(0,3000)]
  );

  res.json({ result });
}));

// ── Cross-Platform Posting ────────────────────────────────────────────────────
app.post("/generate/cross-platform", authMW, asyncH(async (req, res) => {
  await checkLimit(req.user.id, req.user.plan);

  const apiKey = await getAnthropicKey(req.user.id);
  if (!apiKey) return res.status(400).json({ error: "No Anthropic API key configured" });

  const { profileId, videoTitle, videoDescription, platforms } = req.body;
  if (!videoTitle) return res.status(400).json({ error: "videoTitle required" });

  let profileCtx = "";
  if (profileId) {
    const { rows: p } = await pool.query("SELECT * FROM channel_profiles WHERE id=$1 AND user_id=$2", [profileId, req.user.id]);
    if (p[0]) profileCtx = `Channel: ${p[0].channel_name}, Tone: ${p[0].tone}`;
  }

  const system = `You are a social media strategist who specializes in cross-platform content distribution for YouTubers. You know each platform's algorithm and culture intimately.`;

  const targetPlatforms = platforms || ["Twitter/X", "Instagram", "TikTok", "Facebook", "LinkedIn", "Reddit", "Pinterest"];

  const prompt = `Create cross-platform promotion posts for this YouTube video:
Title: "${videoTitle}"
${videoDescription ? `Description: ${videoDescription}` : ""}
${profileCtx ? `Creator: ${profileCtx}` : ""}

For each platform (${targetPlatforms.join(", ")}), provide:
1. Platform-specific post copy (matching each platform's culture and character limits)
2. Hashtag strategy (platform-specific)
3. Best posting time
4. Image/graphic suggestion
5. Story/Reel version if applicable

Also provide:
- **Email newsletter blurb** (for creators with an email list)
- **Discord/Community announcement**
- **YouTube Community Tab post**`;

  const result = await callClaude(apiKey, system, prompt, 3000);

  await pool.query(
    "INSERT INTO generations (user_id,profile_id,type,prompt,result,created_at) VALUES ($1,$2,$3,$4,$5,now())",
    [req.user.id, profileId||null, "cross_platform", videoTitle.slice(0,500), result.slice(0,3000)]
  );

  res.json({ result });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// VIRAL SERIES
// ═══════════════════════════════════════════════════════════════════════════════

app.get("/viral-series", authMW, asyncH(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM viral_series WHERE user_id=$1 ORDER BY created_at DESC",
    [req.user.id]
  );
  res.json(rows);
}));

app.post("/viral-series/generate", authMW, asyncH(async (req, res) => {
  await checkLimit(req.user.id, req.user.plan);

  const apiKey = await getAnthropicKey(req.user.id);
  if (!apiKey) return res.status(400).json({ error: "No Anthropic API key configured" });

  const { profileId, seriesLength, goal } = req.body;

  let profileCtx = "a YouTube creator";
  let profile = null;
  if (profileId) {
    const { rows: p } = await pool.query("SELECT * FROM channel_profiles WHERE id=$1 AND user_id=$2", [profileId, req.user.id]);
    if (p[0]) {
      profile = p[0];
      profileCtx = `a YouTube creator in the ${p[0].niche || "general"} niche, channel name: ${p[0].channel_name}, target audience: ${p[0].target_audience || "general"}`;
    }
  }

  const system = `You are a viral content strategist who has helped hundreds of YouTubers hit 1 million subscribers. You understand trending formats, emotional hooks, and what makes content spread organically.`;

  const prompt = `Generate 3 DIFFERENT viral series concepts for ${profileCtx}.
Goal: ${goal || "grow the channel and go viral"}
Series length: ${seriesLength || "8-12 episodes"} each

For EACH series concept provide:
1. **Series Title** (punchy, searchable)
2. **Core Concept** (the big idea in 2 sentences)
3. **Why It Will Go Viral** (the psychological/social trigger)
4. **Episode Titles** (full list for all episodes)
5. **Episode 1 Full Breakdown** (title, hook, structure, key moments)
6. **Thumbnail Strategy** (consistent visual identity across series)
7. **SEO Strategy** (how to rank the whole series)
8. **Collaboration Opportunities** (who to invite on)
9. **Monetization Angle** (how this series leads to revenue)
10. **Expected Timeline to Viral** (realistic projection)`;

  const result = await callClaude(apiKey, system, prompt, 4000);

  // Save the series
  const { rows } = await pool.query(
    "INSERT INTO viral_series (user_id,profile_id,title,concept,status,created_at) VALUES ($1,$2,$3,$4,$5,now()) RETURNING *",
    [req.user.id, profileId||null, "AI Generated Series", result.slice(0,200), "draft"]
  );

  await pool.query(
    "INSERT INTO generations (user_id,profile_id,type,prompt,result,created_at) VALUES ($1,$2,$3,$4,$5,now())",
    [req.user.id, profileId||null, "viral_series", "viral_series_generation", result.slice(0,3000)]
  );

  res.json({ result, seriesId: rows[0].id });
}));

app.delete("/viral-series/:id", authMW, asyncH(async (req, res) => {
  await pool.query("DELETE FROM viral_series WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// COLLABORATIONS
// ═══════════════════════════════════════════════════════════════════════════════

app.get("/collaborations", authMW, asyncH(async (req, res) => {
  // Get sent invites
  const { rows: sent } = await pool.query(
    `SELECT c.*, cp.channel_name as profile_name, u2.email as invitee_email_confirmed
     FROM collaborations c
     LEFT JOIN channel_profiles cp ON cp.id = c.profile_id
     LEFT JOIN users u2 ON u2.id = c.invitee_id
     WHERE c.inviter_id=$1 ORDER BY c.created_at DESC`,
    [req.user.id]
  );
  // Get received invites
  const { rows: received } = await pool.query(
    `SELECT c.*, u.email as inviter_email, cp.channel_name as profile_name
     FROM collaborations c
     JOIN users u ON u.id = c.inviter_id
     LEFT JOIN channel_profiles cp ON cp.id = c.profile_id
     WHERE c.invitee_email=$1 OR c.invitee_id=$2 ORDER BY c.created_at DESC`,
    [req.user.email, req.user.id]
  );
  res.json({ sent, received });
}));

app.post("/collaborations/invite", authMW, asyncH(async (req, res) => {
  const { inviteeEmail, profileId, message } = req.body;
  if (!inviteeEmail) return res.status(400).json({ error: "inviteeEmail required" });

  // Check if invitee exists
  const { rows: invitee } = await pool.query("SELECT id FROM users WHERE email=$1", [inviteeEmail.toLowerCase().trim()]);

  const { rows } = await pool.query(
    `INSERT INTO collaborations (inviter_id,invitee_email,invitee_id,profile_id,message,status,created_at)
     VALUES ($1,$2,$3,$4,$5,'pending',now()) RETURNING *`,
    [req.user.id, inviteeEmail.toLowerCase().trim(), invitee[0]?.id||null, profileId||null, message||null]
  );

  res.json({ ok: true, collaboration: rows[0], inviteeIsUser: !!invitee[0] });
}));

app.patch("/collaborations/:id/status", authMW, asyncH(async (req, res) => {
  const { status } = req.body; // accepted | declined
  if (!["accepted","declined"].includes(status)) return res.status(400).json({ error: "Invalid status" });

  const { rows } = await pool.query(
    `UPDATE collaborations SET status=$1, invitee_id=COALESCE(invitee_id,$2) 
     WHERE id=$3 AND (invitee_email=$4 OR invitee_id=$2) RETURNING *`,
    [status, req.user.id, req.params.id, req.user.email]
  );
  if (!rows.length) return res.status(404).json({ error: "Collaboration not found" });
  res.json(rows[0]);
}));

// Generate a collab pitch using AI
app.post("/collaborations/generate-pitch", authMW, asyncH(async (req, res) => {
  await checkLimit(req.user.id, req.user.plan);

  const apiKey = await getAnthropicKey(req.user.id);
  if (!apiKey) return res.status(400).json({ error: "No Anthropic API key configured" });

  const { profileId, targetCreator, collabIdea } = req.body;

  let myChannel = "my YouTube channel";
  if (profileId) {
    const { rows: p } = await pool.query("SELECT * FROM channel_profiles WHERE id=$1 AND user_id=$2", [profileId, req.user.id]);
    if (p[0]) myChannel = `${p[0].channel_name} (${p[0].niche} niche, audience: ${p[0].target_audience})`;
  }

  const system = `You are a YouTube networking and collaboration expert. You write compelling, professional collab pitches that actually get responses.`;

  const prompt = `Write a collaboration pitch from ${myChannel} to ${targetCreator || "another creator"}.
Collab idea: ${collabIdea || "joint video / cross-promotion"}

Provide:
1. **Email Subject Line** (3 options)
2. **Full Pitch Email** (professional, personal, specific — not a template)
3. **DM Version** (shorter, for Instagram/Twitter)
4. **Follow-up Message** (if no response after 1 week)
5. **Collab Video Concept** (3 specific ideas that benefit both channels)`;

  const result = await callClaude(apiKey, system, prompt, 2000);

  await pool.query(
    "INSERT INTO generations (user_id,profile_id,type,prompt,result,created_at) VALUES ($1,$2,$3,$4,$5,now())",
    [req.user.id, profileId||null, "collab_pitch", `pitch_to_${targetCreator||"creator"}`, result.slice(0,3000)]
  );

  res.json({ result });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════════════════════════════════════════

app.get("/history", authMW, asyncH(async (req, res) => {
  const limit = PLAN_LIMITS[req.user.plan || "free"].history;
  const type  = req.query.type; // optional filter
  const { rows } = await pool.query(
    `SELECT id,type,prompt,result,created_at,profile_id FROM generations
     WHERE user_id=$1 ${type ? "AND type=$3" : ""} ORDER BY created_at DESC LIMIT $2`,
    type ? [req.user.id, limit, type] : [req.user.id, limit]
  );
  res.json(rows);
}));

app.delete("/history/:id", authMW, asyncH(async (req, res) => {
  await pool.query("DELETE FROM generations WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// STRIPE
// ═══════════════════════════════════════════════════════════════════════════════

app.get("/stripe/plans", asyncH(async (_req, res) => {
  res.json({
    pro: { priceId: process.env.STRIPE_PRO_PRICE_ID, link: process.env.STRIPE_PRO_PAYMENT_LINK, price: "$19/mo" },
  });
}));

app.post("/stripe/create-checkout", authMW, asyncH(async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
  const { priceId } = req.body;
  if (!priceId) return res.status(400).json({ error: "priceId required" });
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.FRONTEND_URL || ""}/?upgraded=1`,
    cancel_url:  `${process.env.FRONTEND_URL || ""}/?upgrade=cancelled`,
    metadata:    { userId: String(req.user.id) },
  });
  res.json({ url: session.url });
}));

app.post("/stripe/webhook", asyncH(async (req, res) => {
  if (!stripe) return res.status(503).send("Stripe not configured");
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_HOOK);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  const obj = event.data.object;
  if (event.type === "checkout.session.completed") {
    const userId = obj.metadata?.userId;
    if (!userId) return res.json({ received: true });
    const sub   = await stripe.subscriptions.retrieve(obj.subscription);
    const price = sub.items.data[0]?.price?.id;
    const plan  = price === process.env.STRIPE_PRO_PRICE_ID ? "pro" : "free";
    await pool.query(
      "UPDATE users SET plan=$1, stripe_customer_id=$2, stripe_subscription_id=$3, plan_updated_at=now() WHERE id=$4",
      [plan, obj.customer, obj.subscription, userId]
    );
  }
  if (event.type === "customer.subscription.deleted") {
    await pool.query(
      "UPDATE users SET plan='free', stripe_subscription_id=NULL, plan_updated_at=now() WHERE stripe_subscription_id=$1",
      [obj.id]
    );
  }
  res.json({ received: true });
}));

// ── Account ───────────────────────────────────────────────────────────────────
app.delete("/account", authMW, asyncH(async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password required" });
  const { rows } = await pool.query("SELECT password_hash FROM users WHERE id=$1", [req.user.id]);
  if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash)))
    return res.status(401).json({ error: "Incorrect password" });
  await pool.query("DELETE FROM users WHERE id=$1", [req.user.id]);
  res.json({ ok: true });
}));

// ── Admin ─────────────────────────────────────────────────────────────────────
app.get("/admin/stats", authMW, asyncH(async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: "Admin only" });
  const [u, g] = await Promise.all([
    pool.query("SELECT COUNT(*) AS cnt FROM users"),
    pool.query("SELECT COUNT(*) AS cnt FROM generations WHERE created_at >= date_trunc('month',now())"),
  ]);
  res.json({ totalUsers: +u.rows[0].cnt, generationsMonth: +g.rows[0].cnt });
}));

// ── Error handler ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error("Unhandled:", err);
  res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Server error" : err.message });
});

app.listen(PORT, () => console.log(`youtube_for_all on :${PORT}`));
