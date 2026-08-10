-- CareerPersona AI — Subscription & Billing — Stripe Sandbox Connection, Migration 1
-- Connects the two CareerPersona subscription Products created in Stripe
-- SANDBOX (test mode) to the existing, already-built config-driven checkout
-- architecture (Blueprint #2/#3). No code change is required for this --
-- handleCheckoutSession/handleChangePlan/determineTierFromStripeSubscription
-- already read these two keys from platform_config exclusively; setting the
-- values is the entire "connection."
--
-- Test-mode Price IDs only (per explicit instruction -- Live-mode configuration
-- is a separate, later step, not part of this migration):
--   Pro     — CareerPersona Pro, $29.99/month     — price_1U2iUT0KFW9J668QijOe5xFD
--   Premium — CareerPersona Premium, $39.99/month — price_1U2iWQ0KFW9J668QhVxV96JZ
--
-- Uses upsert semantics (not a plain UPDATE) because, at authoring time, the
-- stripe_price_id_premium row itself has not yet reached this environment --
-- it is seeded by migration 20260809000000_add_premium_price_config.sql,
-- which was still pending application as of this migration. This keeps the
-- statement correct regardless of which of the two runs first.
--
-- Free has no Stripe product and is intentionally not represented here --
-- there is no stripe_price_id_free key anywhere in this schema, by design.

INSERT INTO public.platform_config (key, value, description)
VALUES
  ('stripe_price_id_pro',     'price_1U2iUT0KFW9J668QijOe5xFD', 'Stripe Price ID for Pro plan monthly — SANDBOX/test mode'),
  ('stripe_price_id_premium', 'price_1U2iWQ0KFW9J668QhVxV96JZ', 'Stripe Price ID for Premium plan monthly — SANDBOX/test mode')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at = now();
