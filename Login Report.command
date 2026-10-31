#!/bin/bash
# Double-click to run the daily sign-in report in a Terminal window. Same as
# scripts/login-report.sh from the repo root; the window stays open to read it.
cd "$(dirname "$0")" || exit 1
scripts/login-report.sh
echo
echo "Done. The report is also saved under reports/logins/. Press Return to close this window."
read -r
