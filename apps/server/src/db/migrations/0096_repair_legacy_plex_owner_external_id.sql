-- Plex owner accounts created before a018ab41 (2026-01-07) stored the plex.tv
-- account id in external_id instead of the local PMS id. Sessions report the
-- local id, so the poller never matches the owner account and mints a second
-- one under its own identity on every stream. Merging them fixes it until the
-- next stream, because the merge deletes the account the sessions map to.
--
-- external_id = plex_account_id is the signature of that legacy write, and a
-- healthy owner never matches it: its external_id is the local id while
-- plex_account_id is the plex.tv one. Without that guard this would fire on a
-- healthy install whose owner shares a username with a Plex Home profile and
-- overwrite a correct external_id, manufacturing the very bug it repairs. A
-- legacy row whose plex_account_id was never synced is left alone on purpose;
-- there is nothing to tell it apart from a healthy one.
--
-- The replacement id comes from the duplicate, because a real session produced
-- it. Hardcoding '1' would be wrong on a server whose owner is not local
-- account 1.
--
-- Re-running is a no-op: a repaired owner no longer satisfies
-- external_id = plex_account_id.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    -- DISTINCT ON keeps this deterministic when an owner has several candidate
    -- duplicates; without it the last iteration's external id won arbitrarily.
    SELECT DISTINCT ON (o.id)
           o.id          AS owner_su,
           o.user_id     AS owner_user,
           d.id          AS dup_su,
           d.user_id     AS dup_user,
           d.external_id AS live_external_id
    FROM server_users o
    JOIN servers s ON s.id = o.server_id AND s.type = 'plex'
    JOIN server_users d
      ON d.server_id = o.server_id
     AND d.user_id <> o.user_id
     AND d.username = o.username
     AND d.is_server_admin = false
     AND d.plex_account_id IS NULL
    WHERE o.is_server_admin = true
      AND o.plex_account_id IS NOT NULL
      AND o.external_id = o.plex_account_id
      AND o.external_id <> d.external_id
      AND NOT EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = d.user_id
          AND (u.password_hash IS NOT NULL
               OR u.plex_account_id IS NOT NULL
               OR u.role IN ('owner', 'admin', 'viewer')
               OR EXISTS (SELECT 1 FROM plex_accounts pa WHERE pa.user_id = u.id)
               OR EXISTS (SELECT 1 FROM auth_accounts aa WHERE aa.user_id = u.id))
      )
    ORDER BY o.id, d.created_at
  LOOP
    -- Two admin rows on one server can both match the same duplicate. Once the
    -- first has taken its external id, the second would collide on
    -- server_users_server_external_unique and abort the whole batch.
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM server_users WHERE id = r.dup_su);

    UPDATE sessions         SET server_user_id = r.owner_su WHERE server_user_id = r.dup_su;
    UPDATE automation_runs  SET server_user_id = r.owner_su WHERE server_user_id = r.dup_su;
    UPDATE termination_logs SET server_user_id = r.owner_su WHERE server_user_id = r.dup_su;
    UPDATE automations      SET server_user_id = r.owner_su, updated_at = now()
                            WHERE server_user_id = r.dup_su;

    -- Identity-scoped rules would cascade away with the phantom identity below.
    UPDATE automations SET user_id = r.owner_user, updated_at = now()
    WHERE user_id = r.dup_user;

    -- The duplicate holds the recent activity; dropping it would regress the
    -- owner's last_activity_at and misfire account-inactivity rules.
    UPDATE server_users o
    SET last_activity_at = greatest(o.last_activity_at, d.last_activity_at),
        joined_at = least(o.joined_at, d.joined_at)
    FROM server_users d
    WHERE o.id = r.owner_su AND d.id = r.dup_su;

    DELETE FROM server_users WHERE id = r.dup_su;

    DELETE FROM users u
    WHERE u.id = r.dup_user
      AND NOT EXISTS (SELECT 1 FROM server_users su WHERE su.user_id = u.id);

    UPDATE server_users
    SET external_id = r.live_external_id, updated_at = now()
    WHERE id = r.owner_su;

    -- Mirrors recomputeIdentityAggregates, which the runtime merge path runs
    -- and a raw SQL fold otherwise skips.
    UPDATE users u
    SET aggregate_trust_score = coalesce(a.trust, 100),
        total_violations = coalesce(v.violations, 0),
        first_joined_at = a.first_joined_at,
        last_activity_at = a.last_activity_at,
        updated_at = now()
    FROM (
      SELECT coalesce(
               min(trust_score) FILTER (WHERE removed_at IS NULL),
               min(trust_score)
             ) AS trust,
             min(joined_at) AS first_joined_at,
             max(last_activity_at) AS last_activity_at
      FROM server_users
      WHERE user_id = r.owner_user
    ) a
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS violations
      FROM automation_runs v
      JOIN server_users su ON su.id = v.server_user_id
      WHERE su.user_id = r.owner_user
        AND v.dismissed_at IS NULL
        AND v.kind = 'policy'
        AND v.outcome = 'completed'
    ) v ON true
    WHERE u.id = r.owner_user;

    RAISE NOTICE 'Repaired plex owner account % to external_id %', r.owner_su, r.live_external_id;
  END LOOP;
END $$;
