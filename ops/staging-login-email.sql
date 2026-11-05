-- User-requested login addresses for active workspaces with an approved strategy.
-- No passwords, hashes, tokens, workspace names or strategy content are selected.
SELECT DISTINCT u.email
FROM users u
JOIN memberships m ON m.user_id=u.id AND m.status='active'
JOIN workspaces w ON w.id=m.workspace_id AND w.status='active'
WHERE EXISTS (SELECT 1 FROM strategy_versions s WHERE s.workspace_id=w.id AND s.status='approved')
ORDER BY u.email
LIMIT 10;
