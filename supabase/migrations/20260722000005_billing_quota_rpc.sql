-- CareerPersona AI — Subscription & Billing — Phase 1, Migration F
-- Atomic check-and-consume quota RPC. Called exclusively by the Worker (service_role).
-- Blueprint #1 + #2: Layer 2 quota check (SELECT FOR UPDATE → atomic increment).

CREATE OR REPLACE FUNCTION public.check_and_consume_quota(
  p_user_id uuid,
  p_feature  text,
  p_limit    integer,
  p_period   text DEFAULT 'trial'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_usage integer;
BEGIN
  -- Ensure a row exists before acquiring the lock
  INSERT INTO public.feature_usage (user_id, feature, period_key, usage_count, last_used_at)
  VALUES (p_user_id, p_feature, p_period, 0, now())
  ON CONFLICT (user_id, feature, period_key) DO NOTHING;

  -- Atomically read current usage and lock the row
  SELECT usage_count
  INTO   v_usage
  FROM   public.feature_usage
  WHERE  user_id    = p_user_id
    AND  feature    = p_feature
    AND  period_key = p_period
  FOR UPDATE;

  -- Quota exhausted — return denied without incrementing
  IF v_usage >= p_limit THEN
    RETURN jsonb_build_object(
      'allowed',     false,
      'usage_count', v_usage,
      'limit',       p_limit
    );
  END IF;

  -- Quota available — increment and confirm
  UPDATE public.feature_usage
  SET    usage_count  = usage_count + 1,
         last_used_at = now()
  WHERE  user_id    = p_user_id
    AND  feature    = p_feature
    AND  period_key = p_period;

  RETURN jsonb_build_object(
    'allowed',     true,
    'usage_count', v_usage + 1,
    'limit',       p_limit
  );
END;
$$;

-- Restrict to service_role only — the Worker is the sole caller.
-- Frontend clients must never call this directly (they could spoof p_user_id).
REVOKE EXECUTE ON FUNCTION public.check_and_consume_quota(uuid, text, integer, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.check_and_consume_quota(uuid, text, integer, text) TO service_role;
