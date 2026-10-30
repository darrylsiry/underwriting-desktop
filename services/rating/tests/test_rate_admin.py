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
    assert page.status_code == 200 and "was 1.1" in page.text and "1 changed" in page.text

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
    assert res.status_code == 303 and "Unrecognised+field" in res.headers["location"]


def test_activate_retires_previous(client, draft):
    assert client.post(f"/rate-versions/{draft['id']}/activate", json={"actor": "pat", "reason": ""}).status_code == 422
    res = client.post(f"/rate-versions/{draft['id']}/activate", json={"actor": "pat", "reason": "Approved"})
    assert res.json()["status"] == "active"
    statuses = {v["label"]: v["status"] for v in client.get("/rate-versions").json()}
    assert statuses == {"2026.1": "retired", "2026.2": "active"}
    assert client.post("/rate", json=ELECTRICAL).json()["rate_version"] == "2026.2"
    assert edit(client, draft["id"], value=1.3).status_code == 409


def test_admin_shows_the_desktop_nav_only_when_proxied_by_the_desktop(client):
    """Through the UW Desktop's /admin proxy the page keeps the desktop's top nav; standalone it doesn't."""
    inside = client.get("/admin", headers={"x-uw-desktop": "1", "x-uw-user": "underwriter3<b>"}).text
    assert 'href="/submissions"' in inside and 'href="/insureds"' in inside and 'class="current">Rate tables' in inside
    assert "Signed in as" in inside and "underwriter3&lt;b&gt;" in inside  # escaped
    assert 'href="/docs"' not in inside  # the desktop doesn't proxy the API docs
    standalone = client.get("/admin").text
    assert "Rating admin" in standalone and 'href="/submissions"' not in standalone
