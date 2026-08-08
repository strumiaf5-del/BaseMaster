"""FastAPI routers for the Audio Mastering API."""

from .dashboard import create_dashboard_router
from .info import create_info_router
from .jobs import create_jobs_router
from .library import create_library_router
from .reference_library import create_reference_library_router

__all__ = [
    "create_dashboard_router",
    "create_info_router",
    "create_jobs_router",
    "create_library_router",
    "create_reference_library_router",
]
