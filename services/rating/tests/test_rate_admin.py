"""Rate-table admin: drafts, audited edits, activation, and the /admin UI.

Runs after test_api.py (it activates a new version, which changes the default
rate version for later tests). Tests in this file share one draft and run in order.
"""
import pytest

from tests.test_api import ELECTRICAL


@pytest.fixture(scope="module")
def draft(client):
    res = client.post("/rate-versions", json={"label": "2026.2", "notes": "TX review", "actor": "pat"})
    assert res.status_code == 201, res.text
    return res.json()


def edit(client, version_id, reason="TX loss trend", **factor):
    return client.post(f"/rate-versions/{version_id}/edits", json={
        "actor": "pat", "reason": reason,
        "edits": [{"kind": "factor", "factor": "territory", "key": "TX", "value": 1.10} | factor],
    })


def test_draft_copies_active_version(client, draft):
    assert draft["status"] == "draft" and draft["based_on"] == 1
    tables = client.get(f"/rate-versions/{draft['id']}").json()
    assert len(tables["classes"]) == 8 and len(tables["factors"]) == 34


def test_duplicate_label_rejected(client, draft):
    assert client.post("/rate-versions", json={"label": "2026.2"}).status_code == 422


@pytest.mark.parametrize("label", ["x'); alert(1); ('", " ", "a" * 33, "2026.3<b>"])
def test_label_characters_are_constrained(client, label):
    """A label is shown on the page and in attributes, so it's letters, digits and . _ - only (CR-044)."""
    assert client.post("/rate-versions", json={"label": label, "actor": "pat"}).status_code == 422
    res = client.post("/admin/versions", follow_redirects=False, data={"based_on": "1", "label": label, "actor": "pat"})
    assert res.status_code == 303 and "/admin?error=" in res.headers["location"]
    assert label.strip() not in {v["label"] for v in client.get("/rate-versions").json()}


def test_activate_confirmation_does_not_inline_the_label(client, draft):
    page = client.get(f"/admin/versions/{draft['id']}").text
    assert "confirm(this.dataset.confirm)" in page and "confirm('Activate" not in page


def test_cross_site_form_posts_are_refused(client, draft):
    """A hostile page can make the admin's browser post here; Origin or Sec-Fetch-Site gives it away (CR-051)."""
    data = {"reason": "x", "actor": "mallory"}
    for headers in ({"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}, {"Referer": "https://evil.example/p"}):
        res = client.post(f"/admin/versions/{draft['id']}/activate", data=data, headers=headers, follow_redirects=False)
        assert res.status_code == 403, headers
        res = client.post(f"/admin/versions/{draft['id']}/sections/territory", data=data | {"factor|territory|TX|value": "9"},
                          headers=headers, follow_redirects=False)
        assert res.status_code == 403, headers
        assert client.post("/admin/versions", data={"based_on": "1", "label": "evil", "actor": "m"}, headers=headers).status_code == 403
    assert client.get(f"/rate-versions/{draft['id']}").json()["status"] == "draft"
    assert all(v["label"] != "evil" for v in client.get("/rate-versions").json())
    # The site's own form (and a client sending neither header) still gets through: nothing changed, so 303 back with a message.
    for headers in ({"Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"}, {}):
        res = client.post(f"/admin/versions/{draft['id']}/sections/territory", headers=headers, follow_redirects=False,
                          data={"factor|territory|TX|value": "1.1", "reason": "no-op", "actor": "pat"})
        assert res.status_code == 303 and "Nothing+changed" in res.headers["location"], headers


def test_edit_is_audited_and_only_changes_count(client, draft):
    res = edit(client, draft["id"], value=1.20)
    assert res.json() == {"changed": 1}
    assert edit(client, draft["id"], value=1.2).json() == {"changed": 0}  # same value: no audit row

    [row] = [a for a in client.get(f"/rate-table-audit?version_id={draft['id']}").json() if a["action"] == "update_factor"]
    assert row["entity"] == "territory:TX" and row["actor"] == "pat" and row["reason"] == "TX loss trend"
    assert row["before"] == {"value": "1.1000"} and row["after"] == {"value": "1.2"}


def test_rating_can_pin_the_draft(client, draft):
    # 44,200 base × 1.20 TX × 0.93 ded × 1.10 height = 54,259.92
    assert client.post("/rate", json=ELECTRICAL | {"rate_version_id": draft["id"]}).json()["premium"] == "54260"
    assert client.post("/rate", json=ELECTRICAL).json()["premium"] == "49738"  # active version unchanged


@pytest.mark.parametrize("payload, status", [
    ({"reason": ""}, 422),                      # reason required
    ({"value": -1}, 422),                       # must be positive
    ({"key": "ZZ", "value": 1.3}, 404),         # unknown key
])
def test_bad_edits(client, draft, payload, status):
    assert edit(client, draft["id"], **payload).status_code == status


def test_active_version_is_frozen(client):
    assert edit(client, 1, value=1.5).status_code == 409


def test_admin_ui_edits_a_variable(client, draft):
    page = client.get(f"/admin/versions/{draft['id']}?section=territory")
    assert page.status_code == 200 and "was 1.10" in page.text and "1 changed" in page.text   # UX-019: 1.10, not 1.1

    res = client.post(f"/admin/versions/{draft['id']}/sections/territory", follow_redirects=False,
                      data={"factor|territory|FL|value": "1.35", "factor|territory|TX|value": "1.2",
                            "reason": "FL hurricane-season claims", "actor": "sam"})
    assert res.status_code == 303 and "Saved+1+change" in res.headers["location"]
    fl = next(f for f in client.get(f"/rate-versions/{draft['id']}").json()["factors"] if f["key"] == "FL")
    assert fl["value"] == 1.35
    assert "sam" in client.get("/admin").text  # recent changes on the versions page


def test_signed_in_desktop_user_is_the_actor(client, draft):
    """Through the UW Desktop proxy the signed-in user is recorded, whatever the form says; no name box."""
    who = {"x-uw-desktop": "1", "x-uw-user": "underwriter7"}
    page = client.get(f"/admin/versions/{draft['id']}?section=territory", headers=who).text
    assert 'name="actor"' not in page
    res = client.post(f"/admin/versions/{draft['id']}/sections/territory", follow_redirects=False, headers=who,
                      data={"factor|territory|FL|value": "1.4", "reason": "FL trend", "actor": "mallory"})
    assert res.status_code == 303 and "rating_admin_user" not in res.headers.get("set-cookie", "")
    [row] = [a for a in client.get(f"/rate-table-audit?version_id={draft['id']}").json()
             if a["action"] == "update_factor" and "1.4" in str(a.get("after"))]
    assert row["actor"] == "underwriter7"
    assert 'name="actor"' in client.get("/admin").text  # standalone (no proxy header) keeps the name field


def test_malformed_field_name_is_an_error_not_a_500(client, draft):
    res = client.post(f"/admin/versions/{draft['id']}/sections/classes", follow_redirects=False,
                      data={"class|a|b|base_rate": "1", "reason": "x", "actor": "sam"})
    assert res.status_code == 422 and "Unrecognised field" in res.text   # UX-001: re-rendered, not redirected


def test_failed_save_keeps_what_was_typed(client, draft):
    """UX-001: a save that fails validation re-renders the editor with the typed values and the message,
    instead of redirecting with ?error= (which reset every edited cell)."""
    url = f"/admin/versions/{draft['id']}/sections/territory"
    res = client.post(url, follow_redirects=False, data={
        "factor|territory|FL|value": "1.45", "factor|territory|TX|value": "1.2", "reason": "", "actor": "sam"})
    assert res.status_code == 422
    assert "A reason is required for rate changes" in res.text
    assert 'value="1.45"' in res.text and 'class="num changed"' in res.text   # typed value kept and flagged
    fl = next(f for f in client.get(f"/rate-versions/{draft['id']}").json()["factors"] if f["key"] == "FL")
    assert fl["value"] == 1.4   # nothing saved

    res = client.post(url, follow_redirects=False, data={
        "factor|territory|FL|value": "1.4", "factor|territory|TX|value": "abc", "reason": "typo test", "actor": "sam"})
    assert res.status_code == 422 and "Every value must be a number" in res.text
    assert 'value="abc"' in res.text and 'value="typo test"' in res.text   # the reason survives too

    page = client.get(f"/admin/versions/{draft['id']}?section=territory").text
    assert 'name="reason" value="" required' in page                              # the reason is required in the browser
    assert 'type="number" min="0.0001" step="any"' in page                        # and the cells refuse non-numbers


def test_activate_retires_previous(client, draft):
    assert client.post(f"/rate-versions/{draft['id']}/activate", json={"actor": "pat", "reason": ""}).status_code == 422
    res = client.post(f"/rate-versions/{draft['id']}/activate", json={"actor": "pat", "reason": "Approved"})
    assert res.json()["status"] == "active"
    statuses = {v["label"]: v["status"] for v in client.get("/rate-versions").json()}
    assert statuses == {"2026.1": "retired", "2026.2": "active"}
    assert client.post("/rate", json=ELECTRICAL).json()["rate_version"] == "2026.2"
    assert edit(client, draft["id"], value=1.3).status_code == 409


def test_activate_card_diffs_against_the_active_version(client):
    """UX-007: a draft copied from a *retired* version shows, before Activate, exactly what would change in
    production (here: two reverts of values 2026.2 moved), and warns about its base."""
    res = client.post("/admin/versions", follow_redirects=False,
                      data={"based_on": "1", "label": "2026.3", "notes": "from retired", "actor": "pat"})
    assert res.status_code == 303
    vid = res.headers["location"].split("/versions/")[1].split("?")[0]
    page = client.get(f"/admin/versions/{vid}").text
    assert "2 values differ from active 2026.2" in page
    assert "<code>FL</code>" in page and "1.40 → <strong>1.25</strong>" in page
    assert "<code>TX</code>" in page and "1.20 → <strong>1.10</strong>" in page
    assert "copied from <strong>retired 2026.1</strong>" in page                      # the base warning
    assert "Unsaved edits in the editor above are not included. Save them first." in page
    assert 'oninput="unsavedEdits()"' in page and 'id="activate-button"' in page
    assert "Territory FL: 1.40 -&gt; 1.25" in page and "confirm(this.dataset.confirm)" in page   # the diff in the confirm text
    assert "2 changed" in page                                                        # nav badge: against active, too
    territory = client.get(f"/admin/versions/{vid}?section=territory").text
    assert "was 1.20" in territory and 'value="1.10"' in territory                   # the editor highlights the revert
    assert "changes shown against <strong>active 2026.2</strong>" in territory


def test_activate_card_says_when_nothing_differs(client):
    """UX-007: a draft copied from the active version, untouched, would change nothing."""
    active = next(v for v in client.get("/rate-versions").json() if v["status"] == "active")
    res = client.post("/admin/versions", follow_redirects=False,
                      data={"based_on": str(active["id"]), "label": "2026.4", "notes": "no-op", "actor": "pat"})
    vid = res.headers["location"].split("/versions/")[1].split("?")[0]
    page = client.get(f"/admin/versions/{vid}").text
    assert "0 values differ from active 2026.2" in page
    assert "No differences from the active version; activating changes nothing." in page
    assert "copied from <strong>retired" not in page
    assert "no differences from active 2026.2" in page   # the confirm text says so as well


def test_numbers_are_shown_with_aligned_decimals(client):
    """UX-019: factors 1.00/0.90/1.35, rates per $1,000 9.40, taxes 0.0489, whole dollars 2500/250."""
    classes = client.get("/admin/versions/1").text
    assert "9.40" in classes and "22.00" in classes and "2500.00" not in classes and "7500.00" not in classes
    territory = client.get("/admin/versions/1?section=territory").text
    assert "0.90" in territory and "1.00" in territory
    assert "0.0489" in client.get("/admin/versions/1?section=sl_tax").text
    params = client.get("/admin/versions/1?section=parameters").text
    assert "0.75" in params and "1.50" in params and "250.0" not in params
    assert "1.10 → <strong>1.20</strong>" in client.get("/admin").text   # the audit trail's TX change


def test_timestamps_are_in_the_display_zone(client, monkeypatch):
    """UX-006: every time on the admin pages carries the zone from DISPLAY_TZ (default America/New_York)."""
    import re
    monkeypatch.delenv("DISPLAY_TZ", raising=False)
    page = client.get("/admin").text
    assert re.search(r"[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M E[DS]T", page), "activation/audit times should show EDT/EST"
    monkeypatch.setenv("DISPLAY_TZ", "UTC")
    assert re.search(r"[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M UTC", client.get("/admin").text)


def test_submit_buttons_show_a_pending_state(client):
    """UX-009: the three forms disable their button and show a pending label on submit."""
    versions = client.get("/admin").text
    assert "function pending(form, label)" in versions and "pending(this, 'Creating draft…')" in versions
    draft = next(v for v in client.get("/rate-versions").json() if v["status"] == "draft")
    page = client.get(f"/admin/versions/{draft['id']}").text
    assert "pending(this, 'Saving…')" in page
    assert "confirm(this.dataset.confirm) && pending(this, 'Activating…')" in page


def test_admin_shows_the_desktop_nav_only_when_proxied_by_the_desktop(client):
    """Through the UW Desktop's /admin proxy the page keeps the desktop's top nav; standalone it doesn't."""
    inside = client.get("/admin", headers={"x-uw-desktop": "1", "x-uw-user": "underwriter3<b>"}).text
    assert 'href="/submissions"' in inside and 'href="/insureds"' in inside and 'class="current">Rate tables' in inside
    assert "Signed in as" in inside and "underwriter3&lt;b&gt;" in inside  # escaped
    assert 'href="/docs"' not in inside  # the desktop doesn't proxy the API docs
    standalone = client.get("/admin").text
    assert "Rating admin" in standalone and 'href="/submissions"' not in standalone
