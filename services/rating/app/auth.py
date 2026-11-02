"""Who may administer rate tables, and who we believe about the acting user (SEC-002).

The UW Desktop's web app calls this service on behalf of signed-in underwriters and names them
in `x-uw-user`. That header is only believed from a caller holding RATING_ADMIN_TOKEN, a shared
secret set on both apps (scripts/fly-deploy.sh). The same token is required for everything that
changes rate tables: the JSON endpoints under /rate-versions and the whole /admin UI.

Without the token configured (local development, tests) the service runs open on localhost as it
always has, and trusts the header. On Fly (FLY_APP_NAME is set) a missing token fails closed for
the mutating endpoints rather than leaving them open.
"""
import os
import secrets
from urllib.parse import unquote

from fastapi import HTTPException, Request


def configured_token() -> str:
    return os.environ.get("RATING_ADMIN_TOKEN", "").strip()


def _bearer(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    return auth[7:].strip() if auth.startswith("Bearer ") else ""


def trusted_caller(request: Request) -> bool:
    """True when the caller may tell us who is acting: holds the token, or no token is configured."""
    token = configured_token()
    if not token:
        return not os.environ.get("FLY_APP_NAME")
    presented = _bearer(request)
    return bool(presented) and secrets.compare_digest(presented, token)


def decode_user(header: str | None) -> str:
    """The name in an x-uw-user header: the web app percent-encodes it, so any name fits in a header (CR-072)."""
    return "".join(c for c in unquote(header or "") if c.isprintable()).strip()[:60]


def acting_user(request: Request) -> str | None:
    """The UW Desktop user named by a trusted caller; None otherwise."""
    if not trusted_caller(request):
        return None
    return decode_user(request.headers.get("x-uw-user")) or None


def require_admin(request: Request) -> None:
    """Dependency for anything that changes rate tables."""
    if not configured_token() and os.environ.get("FLY_APP_NAME"):
        raise HTTPException(503, "Rate-table administration is not configured on this deployment (RATING_ADMIN_TOKEN)")
    if not trusted_caller(request):
        raise HTTPException(401, "Rate-table administration needs the service's bearer token",
                            headers={"WWW-Authenticate": "Bearer"})
