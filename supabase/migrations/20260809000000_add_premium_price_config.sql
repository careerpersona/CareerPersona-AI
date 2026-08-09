-- CareerPersona AI — Subscription & Billing — Premium Checkout, Migration 1
-- Adds the Premium Price ID config key, mirroring stripe_price_id_pro's exact
-- pattern (empty until set via dashboard). Premium checkout stays unavailable
-- (fails safely, not with a placeholder) until this value is set live.
--
-- To enable Premium checkout: UPDATE platform_config SET value = '<real Stripe
-- Price ID>' WHERE key = 'stripe_price_id_premium'. No code deploy required.

INSERT INTO public.platform_config (key, value, description) VALUES
  ('stripe_price_id_premium', '', 'Stripe Price ID for Premium plan monthly — set via dashboard before enabling Premium checkout')
ON CONFLICT (key) DO NOTHING;
