/**
 * youtube_for_all — migrate.js
 * Safe to run on fresh DB and existing DB (idempotent).
 */
"use strict";

const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Users ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                     SERIAL PRIMARY KEY,
        email                  TEXT NOT NULL UNIQUE,
        password_hash          TEXT NOT NULL,
        anthropic_key_enc      TEXT,
        plan                   TEXT NOT NULL DEFAULT 'free',
        is_admin               BOOLEAN NOT NULL DEFAULT FALSE,
        stripe_customer_id     TEXT,
        stripe_subscription_id TEXT,
        plan_updated_at        TIMESTAMPTZ,
        tokens_used            BIGINT NOT NULL DEFAULT 0,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ── Channel Profiles ───────────────────────────────────────────────────
    // Each user can have one or more YouTube channel profiles
    await client.query(`
      CREATE TABLE IF NOT EXISTS channel_profiles (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel_name    TEXT NOT NULL,
        niche           TEXT,
        target_audience TEXT,
        avatar_style    TEXT DEFAULT 'avatar_heavy',
        tone            TEXT DEFAULT 'friendly',
        posting_freq    TEXT DEFAULT 'weekly',
        extra_context   TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ── AI Generations ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS generations (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        profile_id  INTEGER REFERENCES channel_profiles(id) ON DELETE SET NULL,
        type        TEXT NOT NULL DEFAULT 'general',
        prompt      TEXT,
        result      TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ── Viral Series ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS viral_series (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        profile_id  INTEGER REFERENCES channel_profiles(id) ON DELETE SET NULL,
        title       TEXT NOT NULL,
        concept     TEXT,
        episodes    JSONB DEFAULT '[]',
        status      TEXT DEFAULT 'draft',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ── Collaborations ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS collaborations (
        id           SERIAL PRIMARY KEY,
        inviter_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invitee_email TEXT NOT NULL,
        invitee_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        profile_id   INTEGER REFERENCES channel_profiles(id) ON DELETE CASCADE,
        message      TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // ── Indexes ────────────────────────────────────────────────────────────
    await client.query(`CREATE INDEX IF NOT EXISTS idx_gen_user        ON generations(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_gen_created     ON generations(created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_profiles_user   ON channel_profiles(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_collab_inviter  ON collaborations(inviter_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_collab_invitee  ON collaborations(invitee_email)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_viral_user      ON viral_series(user_id)`);

    await client.query("COMMIT");
    console.log("✅ Migration complete");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
