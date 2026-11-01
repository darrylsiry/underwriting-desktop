#!/usr/bin/env bash
# Print "<db>.<table> <rows> <md5 of every row>" for every table in the UAT sandbox's three
# databases. Run before and after the read-only pass: any difference outside login_events means a
# "read-only" function wrote, and the run fails. Sandbox only: it talks to the uwdesk-uat project.
set -euo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
DC=(docker compose -p uwdesk-uat -f "$ROOT/docker-compose.yml" -f "$ROOT/uat/docker-compose.uat.yml")
SQL="SELECT current_database() || '.' || table_name || ' ' ||
  (xpath('/row/n/text()', x))[1]::text || ' ' || (xpath('/row/h/text()', x))[1]::text
FROM (SELECT table_name, query_to_xml(format(
  'SELECT count(*) AS n, md5(coalesce(string_agg(t::text, ''|'' ORDER BY t::text), '''')) AS h FROM public.%I t', table_name),
  false, true, '') AS x
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE') s
ORDER BY 1;"
for db in customer policy rating; do
  "${DC[@]}" exec -T db psql -U uw -d "$db" -tAc "$SQL"
done
# The drop folder: the Submissions page tops it up when fewer than five are waiting (any visitor does this).
echo "inbox.folders $(ls "$ROOT/uat/.work/inbox" | wc -l | tr -d ' ') -"
