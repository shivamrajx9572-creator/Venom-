"""
FamGateway Python SDK (bundled fallback)
Official client library for FamGateway P2P UPI Payment Gateway.
"""

from .client import FamGateway
from .exceptions import (
    FamGatewayError,
    AuthenticationError,
    APIError,
    OrderNotFoundError,
    NetworkError,
)
from .models import OrderResponse, OrderStatus

__version__ = "1.0.4"
__all__ = [
    "FamGateway",
    "FamGatewayError",
    "AuthenticationError",
    "APIError",
    "OrderNotFoundError",
    "NetworkError",
    "OrderResponse",
    "OrderStatus",
]