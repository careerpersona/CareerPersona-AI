-- CareerPersona AI — Subscription & Billing — Premium Checkout, Migration 2
-- Extends profiles_subscription_status_check to allow premium_past_due and
-- premium_cancelled, mirroring pro_past_due/pro_cancelled exactly. Fixes the
-- audit-identified gap where a Premium subscriber's payment failure or
-- cancellation was written as a Pro-tier status (worker.js's webhook handler
-- previously hardcoded pro_past_due/pro_cancelled regardless of actual tier),
-- silently downgrading their grace-period entitlement to Pro's limits instead
-- of Premium's. No existing rows use these values yet, so no data
-- normalization step is needed before replacing the constraint.

ALTER TABLE public.profiles
  DROP CONSTRAINT profiles_subscription_status_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_subscription_status_check CHECK (
    subscription_status IN (
      'no_subscription',
      'pro_active',
      'pro_past_due',
      'pro_cancelled',
      'premium_active',
      'premium_past_due',
      'premium_cancelled',
      'admin'
    )
  );
